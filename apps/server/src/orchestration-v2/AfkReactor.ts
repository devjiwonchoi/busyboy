import {
  AFK_FREE_FORM_ANSWER,
  AFK_GRACE_MS,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
  type ProjectId,
  ProjectTaskEventId,
  type ProjectTaskId,
  type RuntimeRequestId,
  type ThreadId,
  afkActive,
  afkAnswerEventBody,
  afkPickOption,
  afkSetting,
} from "@t3tools/contracts";
import { buildPlanImplementationPrompt, proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as AttentionRouter from "../projectTeam/AttentionRouter.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * While the user is AFK, answers provider questions (Claude AskUserQuestion, Codex
 * request_user_input) with the recommended option and implements proposed plans of
 * plan-mode threads, each after AFK_GRACE_MS so the user can still answer first.
 */
export class AfkReactor extends Context.Service<
  AfkReactor,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Schedules every waiting question and plan in the project; a no-op while AFK is off. */
    readonly sweepProject: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/AfkReactor") {}

export const AFK_PLAN_QUESTION = "Plan ready to implement";
export const AFK_PLAN_ANSWER = "Implement";

/** The answers AFK sends, keyed by question id like the app's, plus what to log. */
export function afkAnswers(questions: ReadonlyArray<OrchestrationV2UserInputQuestion>): {
  readonly answers: Record<string, string | ReadonlyArray<string>>;
  readonly log: ReadonlyArray<{ readonly question: string; readonly answer: string }>;
} {
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  const log: Array<{ question: string; answer: string }> = [];
  for (const question of questions) {
    const picked = afkPickOption(question.options.map((option) => option.label));
    const option = question.options.find((candidate) => candidate.label === picked);
    if (option === undefined) {
      answers[question.id] = AFK_FREE_FORM_ANSWER;
      log.push({ question: question.question, answer: AFK_FREE_FORM_ANSWER });
      continue;
    }
    // The app sends the option's value, falling back to its label.
    const value = option.value ?? option.label;
    answers[question.id] = question.multiSelect === true ? [value] : value;
    log.push({ question: question.question, answer: option.label });
  }
  return { answers, log };
}

type PlanRecords = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "plans">;

/**
 * The proposed plan the user could implement now: the thread is in plan mode, its latest
 * run completed with an active plan, and nothing is running or queued after it.
 */
export function actionablePlan(records: PlanRecords): {
  readonly plan: Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }>;
  readonly run: OrchestrationV2Run;
} | null {
  const { thread } = records;
  if (thread.interactionMode !== "plan" || thread.archivedAt !== null) return null;
  if (records.runs.some((run) => run.status === "queued" || ThreadManagement.isActiveRun(run))) {
    return null;
  }
  const run = ThreadManagement.latestRun(records);
  if (run === undefined || run.status !== "completed") return null;
  const plan = records.plans.findLast(
    (candidate): candidate is Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }> =>
      candidate.kind === "proposed_plan" &&
      candidate.status === "active" &&
      candidate.runId === run.id &&
      candidate.markdown.trim().length > 0,
  );
  return plan === undefined ? null : { plan, run };
}

const millis = (value: DateTime.Utc | null): number | null =>
  value === null ? null : DateTime.toEpochMillis(value);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const scope = yield* Effect.scope;
  const scheduled = yield* Ref.make<ReadonlySet<string>>(new Set());

  const isAfk = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(projectId);
      if (Option.isNone(manager)) return false;
      return afkActive(afkSetting(manager.value.settings), yield* Clock.currentTimeMillis);
    });

  /** The task of a lead thread, or of the lead a subagent thread belongs to. */
  const taskFor = (threadId: ThreadId, parentThreadId: ThreadId | null) =>
    Effect.gen(function* () {
      const own = yield* repository.findTaskByLeadThreadId(threadId);
      if (Option.isSome(own) || parentThreadId === null) return Option.getOrNull(own)?.id ?? null;
      return Option.getOrNull(yield* repository.findTaskByLeadThreadId(parentThreadId))?.id ?? null;
    });

  const logAnswer = (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly taskId: ProjectTaskId | null;
    readonly threadId: ThreadId;
    readonly question: string;
    readonly answer: string;
  }) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* repository.appendTaskEvent({
        id: ProjectTaskEventId.make(input.id),
        projectId: input.projectId,
        taskId: input.taskId,
        kind: "afk_answer",
        body: afkAnswerEventBody(input.question, input.answer),
        actorThreadId: input.threadId,
        createdAt,
      });
    });

  /**
   * Runs `act` once `sinceMs + AFK_GRACE_MS` has passed, in a fiber of its own so the
   * event stream is not held up. A key already waiting is not scheduled twice.
   */
  const schedule = <E>(key: string, sinceMs: number, act: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      const fresh = yield* Ref.modify(scheduled, (keys) =>
        keys.has(key) ? [false, keys] : [true, new Set([...keys, key])],
      );
      if (!fresh) return;
      const wait = Math.max(0, sinceMs + AFK_GRACE_MS - (yield* Clock.currentTimeMillis));
      yield* Effect.sleep(wait).pipe(
        Effect.andThen(act),
        Effect.catchCause((cause) => Effect.logWarning("AFK auto-answer failed", { key, cause })),
        Effect.ensuring(
          Ref.update(scheduled, (keys) => new Set([...keys].filter((entry) => entry !== key))),
        ),
        Effect.forkIn(scope),
      );
    });

  const answerQuestion = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) return;
      if (!(yield* isAfk(shell.projectId))) return;
      const records = yield* threads.getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request"],
      });
      const request = records.runtimeRequests.find((candidate) => candidate.id === requestId);
      if (
        request === undefined ||
        request.kind !== "user_input" ||
        request.status !== "pending" ||
        request.responseCapability.type === "not_resumable"
      ) {
        return;
      }
      const item = records.turnItems.find(
        (candidate) => candidate.type === "user_input_request" && candidate.requestId === requestId,
      );
      if (item?.type !== "user_input_request") return;
      const { answers, log } = afkAnswers(item.questions);
      yield* threads.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`server:afk-answer:${threadId}:${requestId}`),
        threadId,
        requestId,
        answers,
      });
      const taskId = yield* taskFor(threadId, shell.lineage.parentThreadId);
      yield* Effect.forEach(
        log,
        (entry, index) =>
          logAnswer({
            id: `afk:${threadId}:${requestId}:${index}`,
            projectId: shell.projectId,
            taskId,
            threadId,
            ...entry,
          }),
        { discard: true },
      );
    });

  const scheduleQuestion = (threadId: ThreadId, requestId: RuntimeRequestId, sinceMs: number) =>
    schedule(`question:${threadId}:${requestId}`, sinceMs, answerQuestion(threadId, requestId));

  const implementPlan = (threadId: ThreadId, planId: string) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) return;
      if (!(yield* isAfk(shell.projectId))) return;
      const ready = actionablePlan(yield* threads.getThreadRecords(threadId, ["runs", "plans"]));
      if (ready === null || ready.plan.id !== planId) return;
      const { plan } = ready;
      // Same two steps as the app's Implement: leave plan mode, then send the plan.
      yield* threads.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(`server:afk-plan-mode:${threadId}:${plan.id}`),
        threadId,
        interactionMode: "default",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:afk-plan-implement:${threadId}:${plan.id}`),
        threadId,
        messageId: MessageId.make(`message:afk-plan-implement:${threadId}:${plan.id}`),
        text: buildPlanImplementationPrompt(plan.markdown),
        attachments: [],
        sourcePlanRef: { threadId, planId: plan.id },
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* logAnswer({
        id: `afk:${threadId}:${plan.id}`,
        projectId: shell.projectId,
        taskId: yield* taskFor(threadId, shell.lineage.parentThreadId),
        threadId,
        question: proposedPlanTitle(plan.markdown) ?? AFK_PLAN_QUESTION,
        answer: AFK_PLAN_ANSWER,
      });
    });

  /** Schedules the thread's plan when one is waiting and AFK is on. */
  const checkPlan = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ready = actionablePlan(yield* threads.getThreadRecords(threadId, ["runs", "plans"]));
      if (ready === null) return;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || !(yield* isAfk(shell.projectId))) return;
      const sinceMs = millis(ready.run.completedAt) ?? (yield* Clock.currentTimeMillis);
      yield* schedule(
        `plan:${threadId}:${ready.plan.id}`,
        sinceMs,
        implementPlan(threadId, ready.plan.id),
      );
    });

  const handle: AfkReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type === "run.updated") {
        if (event.payload.status === "completed") yield* checkPlan(event.threadId);
        return;
      }
      if (
        event.type !== "runtime-request.updated" ||
        event.payload.kind !== "user_input" ||
        event.payload.status !== "pending"
      ) {
        return;
      }
      const shell = yield* threads.getThreadShell(event.threadId);
      if (shell === null || !(yield* isAfk(shell.projectId))) return;
      yield* scheduleQuestion(
        event.threadId,
        event.payload.id,
        DateTime.toEpochMillis(event.payload.createdAt),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("AFK reactor failed to handle an event", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );

  const sweepProject: AfkReactor["Service"]["sweepProject"] = (projectId) =>
    Effect.gen(function* () {
      if (!(yield* isAfk(projectId))) return;
      const shells = yield* threads.listProjectThreads({ projectId, includeSubagents: true });
      yield* Effect.forEach(
        shells,
        (shell) =>
          Effect.gen(function* () {
            if (shell.archivedAt !== null || shell.deletedAt !== null) return;
            const { runtimeRequests } = yield* threads.getThreadRecords(shell.id, [
              "runtimeRequests",
            ]);
            for (const request of runtimeRequests) {
              if (request.kind !== "user_input" || request.status !== "pending") continue;
              yield* scheduleQuestion(
                shell.id,
                request.id,
                DateTime.toEpochMillis(request.createdAt),
              );
            }
            if (shell.hasActionableProposedPlan) yield* checkPlan(shell.id);
          }),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("AFK sweep failed", { projectId, cause })),
    );

  return { handle, sweepProject } satisfies AfkReactor["Service"];
});

export const layer = Layer.effect(AfkReactor, make);

/** Follows thread events and AFK setting changes, and sweeps AFK projects at startup. */
export const start: Effect.Effect<
  void,
  never,
  | AfkReactor
  | ThreadManagement.ThreadManagementService
  | AttentionRouter.AttentionRouter
  | ProjectTeamRepository.ProjectTeamRepository
  | Scope.Scope
> = Effect.gen(function* () {
  const reactor = yield* AfkReactor;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const router = yield* AttentionRouter.AttentionRouter;
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const changes = yield* router.subscribe;
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, reactor.handle).pipe(
      Effect.catchCause((cause) => Effect.logWarning("AFK event stream failed", { cause })),
    ),
  );
  yield* forkParked(
    Effect.forever(PubSub.take(changes).pipe(Effect.flatMap(reactor.sweepProject))),
  );
  yield* forkParked(
    repository.listManagers().pipe(
      Effect.flatMap((managers) =>
        Effect.forEach(managers, (manager) => reactor.sweepProject(manager.projectId), {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("AFK startup sweep failed", { cause })),
    ),
  );
});

export const layerWorker = Layer.effectDiscard(start).pipe(Layer.provideMerge(layer));
