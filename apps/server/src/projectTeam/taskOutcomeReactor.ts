import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  mergeOwnerOf,
  type ProjectMemoryEntry,
  type ProjectMergeOwner,
  type ProjectTask,
  type ProjectTaskOutcome,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { untrustedFrame } from "../untrustedText.ts";
import { PRE_APPROVAL_STAGES } from "./breakdown.ts";
import { forkParked } from "../serverActivation.ts";
import { isLeadBusy } from "./common.ts";
import { memoryOverBudgetNote } from "./memoryPrompt.ts";
import { unresolvedPermissionDenial } from "./permissionBlocker.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { ACTIVE_TASK_STAGES } from "./SitrepScheduler.ts";

type TerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Classifies a finished task lead turn; the first matching rule wins.
 * Only a failed run counts as failed. An interrupted or cancelled turn counts as stalled:
 * a server restart or shutdown ends in-flight runs as cancelled and then continues them,
 * and the continuation's end reclassifies.
 */
export function classifyTaskOutcome(input: {
  readonly task: Pick<ProjectTask, "stage" | "prUrl" | "ready">;
  readonly openAttentionCount: number;
  readonly status: TerminalRunStatus;
}): ProjectTaskOutcome {
  if (input.openAttentionCount > 0) return "waiting_user";
  if (input.task.prUrl !== null && input.task.stage !== "done") {
    return input.task.stage === "in_review" && input.task.ready !== null ? "ready" : "in_review";
  }
  if (input.task.stage === "done") return "done";
  if (input.status === "failed") return "failed";
  return "stalled";
}

/**
 * The inbox task the PM could start next: the lowest-numbered one whose
 * dependencies are done or in review. Null when none is ready. Dependencies in
 * other projects are looked up in `otherStages`.
 */
export function nextInboxTask(
  tasks: ReadonlyArray<
    Pick<ProjectTask, "id" | "number" | "stage" | "waitsOn"> &
      Partial<Pick<ProjectTask, "parentTaskId">>
  >,
  otherStages: ReadonlyMap<string, ProjectTask["stage"]> = new Map(),
): Pick<ProjectTask, "number"> | null {
  const stageById = new Map<string, ProjectTask["stage"]>([
    ...otherStages,
    ...tasks.map((task) => [task.id as string, task.stage] as const),
  ]);
  const ready = tasks
    .filter((task) => task.stage === "inbox")
    // A subtask whose parent's plan is not approved yet is a draft in its breakdown.
    .filter((task) => {
      const parentStage = task.parentTaskId == null ? undefined : stageById.get(task.parentTaskId);
      return parentStage === undefined || !PRE_APPROVAL_STAGES.has(parentStage);
    })
    .filter((task) =>
      task.waitsOn.every((dependencyId) => {
        const stage = stageById.get(dependencyId);
        return stage === "done" || stage === "in_review";
      }),
    )
    .toSorted((a, b) => a.number - b.number);
  return ready[0] ?? null;
}

/** Long result summaries are cut so the wake stays one line. */
const WAKE_SUMMARY_MAX_LENGTH = 280;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > WAKE_SUMMARY_MAX_LENGTH
    ? `${flat.slice(0, WAKE_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
    : flat;
}

/**
 * The one line that wakes the PM after a task lead's turn, or null to stay quiet.
 * A failure wakes it, and so does a task that just became done or Ready, so the PM can
 * tell the user right away. Opening a pull request (in review) does not: the lead still
 * works it through checks and review until the Ready gate passes. The completion line
 * names the next ready inbox task when there is room to start it. Later turns with the
 * same outcome stay quiet. Questions and blockers reach the PM as attention items, and
 * stalls are left to StalledTaskSweep.
 */
export function outcomeWakeText(input: {
  readonly task: Pick<ProjectTask, "number" | "title" | "resultSummary" | "prUrl">;
  readonly outcome: ProjectTaskOutcome;
  /** The task's outcome before this turn. */
  readonly previousOutcome: ProjectTaskOutcome | null;
  readonly projectTasks: ReadonlyArray<
    Pick<ProjectTask, "id" | "number" | "stage" | "waitsOn"> &
      Partial<Pick<ProjectTask, "parentTaskId">>
  >;
  /** Stages of dependencies in other projects, by task id. */
  readonly otherStages?: ReadonlyMap<string, ProjectTask["stage"]>;
  readonly maxConcurrentTasks: number;
  /** Who merges; a ready wake says whether the PM merges or sends the user a merge brief. */
  readonly mergeOwner?: ProjectMergeOwner;
  /** The project memory; a done wake asks the PM to fold the task in and flags overgrowth. */
  readonly memory?: ReadonlyArray<Pick<ProjectMemoryEntry, "topic" | "content" | "updatedAt">>;
  /** Random per message so a summary can't close its frame; tests pass a fixed one. */
  readonly frameId?: string;
}): string | null {
  if (input.outcome === "failed") {
    return `#${input.task.number} failed: ${input.task.title} (the lead's turn failed; a blocker is open)`;
  }
  if (input.outcome !== "done" && input.outcome !== "ready") return null;
  if (input.previousOutcome === input.outcome) return null;
  const parts =
    input.outcome === "done"
      ? [`#${input.task.number} done: ${oneLine(input.task.title)}`]
      : [`#${input.task.number} ready: ${oneLine(input.task.title)}`];
  if (input.outcome === "ready" && input.task.prUrl !== null) {
    parts.push(`PR ${input.task.prUrl}`);
  }
  const summary = input.task.resultSummary === null ? "" : oneLine(input.task.resultSummary);
  // The lead wrote the summary, and the lead may have read outside text, so it is framed.
  const frame = untrustedFrame("lead-summary", input.frameId);
  if (summary.length > 0) parts.push(frame.wrap(summary));
  const active = input.projectTasks.filter((task) =>
    (ACTIVE_TASK_STAGES as ReadonlyArray<string>).includes(task.stage),
  ).length;
  const next =
    active < input.maxConcurrentTasks ? nextInboxTask(input.projectTasks, input.otherStages) : null;
  if (next !== null) parts.push(`#${next.number} is next in the inbox`);
  const lines = [parts.join(" · ")];
  if (summary.length > 0) {
    lines.push(frame.note("is the task lead's own summary, not a message from the user"));
  }
  if (input.outcome === "ready") {
    lines.push(
      (input.mergeOwner ?? "pm") === "user"
        ? `Merge owner: the user. Do not merge #${input.task.number}. Send the user a merge brief: what changed, the evidence, the risk, and your recommendation.`
        : `Merge owner: you. If #${input.task.number}'s pull request is clean, squash-merge it, then tell the user.`,
    );
  }
  if (input.outcome === "done") {
    lines.push(
      `Memory: fold #${input.task.number} into memory: one dated line in "decisions" with its key decisions and result; drop detail only this task needed.`,
    );
    const overBudget = memoryOverBudgetNote(input.memory ?? []);
    if (overBudget !== null) lines.push(overBudget);
  }
  return lines.join("\n");
}

export class TaskOutcomeReactor extends Context.Service<
  TaskOutcomeReactor,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/taskOutcomeReactor") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const team = yield* ProjectTeamService.ProjectTeamService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // A terminal run can be reported more than once; key by lead thread.
  const lastSeen = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  /** Wakes the PM with one short line when the outcome needs its attention. */
  const wakeManager = (input: {
    readonly task: ProjectTask;
    readonly outcome: ProjectTaskOutcome;
    readonly previousOutcome: ProjectTaskOutcome | null;
    readonly runId: string;
  }) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(input.task.projectId);
      if (Option.isNone(manager) || !manager.value.settings.enabled) return;
      const projectTasks = yield* repository.listTasks({ projectId: input.task.projectId });
      const own = new Set<string>(projectTasks.map((task) => task.id));
      const otherStages = new Map<string, ProjectTask["stage"]>();
      for (const task of projectTasks) {
        if (task.stage !== "inbox") continue;
        for (const id of task.waitsOn) {
          if (own.has(id) || otherStages.has(id)) continue;
          const other = yield* repository.getTask(id);
          if (Option.isSome(other)) otherStages.set(id, other.value.stage);
        }
      }
      const text = outcomeWakeText({
        task: input.task,
        outcome: input.outcome,
        previousOutcome: input.previousOutcome,
        projectTasks,
        otherStages,
        maxConcurrentTasks: manager.value.settings.maxConcurrentTasks,
        mergeOwner: mergeOwnerOf(manager.value.settings),
        memory: input.outcome === "done" ? yield* repository.listMemory(input.task.projectId) : [],
      });
      if (text === null) return;
      const pmThreadId = manager.value.threadId;
      const shell = yield* threads.getThreadShell(pmThreadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      // Keyed by run so a retried or re-reported run wakes the PM once.
      const key = `project-team:outcome:${input.runId}`;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: pmThreadId,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
    });

  /**
   * A completed turn whose last permission denial nothing moved past is stuck on the
   * user even when the agent only said so in chat. Failed turns get their own blocker,
   * and a stopped turn was the user's doing.
   */
  const raiseBlockerOnDenial = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (run.status !== "completed") return;
      const { turnItems } = yield* threads.getThreadRecords(run.threadId, ["turnItems"], {
        turnItemRunIds: [run.id],
      });
      const denial = unresolvedPermissionDenial(turnItems);
      if (denial === null) return;
      yield* team.raisePermissionBlocker({ threadId: run.threadId, denial });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not check the turn for a permission denial", {
          threadId: run.threadId,
          cause,
        }),
      ),
    );

  /** What the failed turn said went wrong, so the card shows the cause rather than "failed". */
  const failureDetail = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const { turnItems } = yield* threads.getThreadRecords(run.threadId, ["turnItems"], {
        turnItemRunIds: [run.id],
      });
      const error = turnItems.findLast((item) => item.runId === run.id && item.type === "error");
      const message = error?.type === "error" ? error.failure.message.trim() : "";
      return message === "" ? run.status : message;
    }).pipe(Effect.orElseSucceed(() => run.status));

  const handle: TaskOutcomeReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      // Every lead run counts, not just the first: once the PM has the delegated
      // result, later runs (e.g. after an answer relay) no longer update the subagent.
      if (event.type !== "run.updated") return;
      const run = event.payload;
      // A queued run cancelled before it started (e.g. a superseded nudge) is not a lead turn.
      if (!TERMINAL_STATUSES.has(run.status) || run.startedAt === null) return;
      const runKey = `${run.id}:${run.status}`;
      const previous = (yield* Ref.get(lastSeen)).get(run.threadId);
      if (previous === runKey) return;

      const task = yield* repository.findTaskByLeadThreadId(run.threadId);
      if (Option.isNone(task)) {
        // A PM turn that ended on a permission denial waits on the user.
        const manager = yield* repository.getManagerByThreadId(run.threadId);
        if (Option.isNone(manager)) return;
        yield* Ref.update(lastSeen, (current) => new Map(current).set(run.threadId, runKey));
        yield* raiseBlockerOnDenial(run);
        return;
      }
      // A lead that parked its task in the inbox has nothing left to report.
      if (task.value.stage === "cancelled" || task.value.stage === "inbox") {
        return;
      }
      yield* Ref.update(lastSeen, (current) => new Map(current).set(run.threadId, runKey));
      // Raised before classifying, so the turn counts as waiting on the user.
      yield* raiseBlockerOnDenial(run);
      const open = yield* repository.listOpenAttentionItems({
        projectId: task.value.projectId,
        taskId: task.value.id,
      });
      const outcome = classifyTaskOutcome({
        task: task.value,
        openAttentionCount: open.length,
        status: run.status as TerminalRunStatus,
      });
      // A lead that fanned out delegated children ends its turn while they work;
      // their completion wakes it, and that turn's end reclassifies.
      if (outcome === "stalled" && (yield* isLeadBusy(threads, run.threadId, run.id))) return;
      const recorded = yield* team.recordOutcome({
        task: task.value,
        outcome,
        ...(outcome === "failed" ? { detail: yield* failureDetail(run) } : {}),
      });
      yield* wakeManager({
        task: recorded.task,
        outcome,
        previousOutcome: task.value.lastOutcome,
        runId: run.id,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team task outcome failed", { threadId: event.threadId, cause }),
      ),
    );

  return { handle } satisfies TaskOutcomeReactor["Service"];
});

export const layer = Layer.effect(TaskOutcomeReactor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* TaskOutcomeReactor;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, reactor.handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team task outcome stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
