/**
 * Wakes the Director with "[목표 점검]" when the workspace's goal alignment gains a new
 * finding: a goal with no open work, open work with no goal, or a blocked path.
 */

import { CommandId, MessageId, type WorkspaceBlockReason } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { MINUTE_MS, isoMillis, makeIdGenerator, makePeriodicGate, nowIso } from "./common.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";

/** At most one goal check per this window, except right after the Director's sitrep. */
export const GOAL_CHECK_MIN_INTERVAL_MS = 10 * MINUTE_MS;
export const GOAL_CHECK_PREFIX = "[목표 점검]";

const REASON_TEXT: Record<Exclude<WorkspaceBlockReason, "waits_on">, string> = {
  fatal: "a blocker card waits on the user",
  waiting_on_user: "a question waits on the user",
  blocked: "the task is blocked",
};

/** Each finding by a stable id, with the line the Director reads. */
export function goalCheckFindings(
  report: ProjectTeamService.GoalAlignmentReport,
): ReadonlyMap<string, string> {
  const findings = new Map<string, string>();
  const active = report.goals.filter((goal) => goal.status === "active");
  // Without goals every open task would read as unaligned; there is nothing to check yet.
  if (active.length === 0) return findings;
  const goalTitle = (goalId: string) =>
    `"${report.goals.find((goal) => goal.id === goalId)?.title ?? goalId}" (${goalId})`;
  const taskText = (taskId: string) => {
    const task = report.tasks.get(taskId);
    return task === undefined ? taskId : `${task.key} ${task.title} (${task.projectTitle})`;
  };
  for (const goalId of report.alignment.goalsWithoutOpenWork) {
    findings.set(`missing:${goalId}`, `Missing work: goal ${goalTitle(goalId)} has no open work.`);
  }
  for (const { taskId } of report.alignment.unalignedTasks) {
    findings.set(`unaligned:${taskId}`, `No goal: ${taskText(taskId)} serves no goal.`);
  }
  for (const path of report.alignment.blockedPaths) {
    const reasons = path.reasons.map((reason) =>
      reason === "waits_on"
        ? `waits on ${path.waitsOnTaskIds.map(taskText).join(", ")}`
        : REASON_TEXT[reason],
    );
    findings.set(
      `blocked:${path.goalId}:${path.taskId}`,
      `Blocked: ${taskText(path.taskId)} for goal ${goalTitle(path.goalId)}: ${reasons.join("; ")}.`,
    );
  }
  return findings;
}

export function goalCheckText(
  added: ReadonlyArray<string>,
  resolved: ReadonlyArray<string>,
): string {
  const lines = [
    `${GOAL_CHECK_PREFIX} Goal alignment changed since the last check. Handle it as in "Working from goals".`,
    "New:",
    ...added.map((line) => `- ${line}`),
  ];
  if (resolved.length > 0) lines.push("Resolved:", ...resolved.map((line) => `- ${line}`));
  return lines.join("\n");
}

interface CheckState {
  /** Findings the Director last heard about. */
  readonly reported: ReadonlyMap<string, string>;
  readonly lastWakeAtMs: number | null;
}

export class GoalAlignmentReactor extends Context.Service<
  GoalAlignmentReactor,
  {
    /** Reads the alignment and wakes the Director when it has something new. */
    readonly check: Effect.Effect<void>;
  }
>()("t3/projectTeam/GoalAlignmentReactor") {}

const make = Effect.gen(function* () {
  const team = yield* ProjectTeamService.ProjectTeamService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const newId = yield* makeIdGenerator;
  const state = yield* Ref.make<CheckState>({ reported: new Map(), lastWakeAtMs: null });

  const check: GoalAlignmentReactor["Service"]["check"] = Effect.gen(function* () {
    const found = yield* team.goalAlignmentReport;
    if (Option.isNone(found)) return;
    const report = found.value;
    const { director } = report;
    if (!director.settings.enabled) return;
    const findings = goalCheckFindings(report);
    const { reported, lastWakeAtMs } = yield* Ref.get(state);
    const added = [...findings].flatMap(([id, line]) => (reported.get(id) === line ? [] : [line]));
    // Something resolving alone is no reason to wake; it is listed with the next new finding.
    if (added.length === 0) return;
    const resolved = [...reported].flatMap(([id, line]) => (findings.has(id) ? [] : [line]));
    const nowMs = isoMillis(yield* nowIso);
    const sitrepSinceWake =
      lastWakeAtMs !== null &&
      director.lastSitrepAt !== null &&
      isoMillis(director.lastSitrepAt) > lastWakeAtMs;
    if (
      lastWakeAtMs !== null &&
      nowMs - lastWakeAtMs < GOAL_CHECK_MIN_INTERVAL_MS &&
      !sitrepSinceWake
    ) {
      return;
    }
    const shell = yield* threads.getThreadShell(director.threadId);
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
    const key = `project-team:goal-check:${yield* newId("goal-check")}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(key),
      threadId: director.threadId,
      messageId: MessageId.make(key),
      text: goalCheckText(added, resolved),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "system",
      creationSource: "server",
    });
    yield* Ref.set(state, { reported: findings, lastWakeAtMs: nowMs });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("project team goal check failed", { cause })),
  );

  return { check } satisfies GoalAlignmentReactor["Service"];
});

export const layer = Layer.effect(GoalAlignmentReactor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* GoalAlignmentReactor;
    const scheduler = yield* Scheduler.Scheduler;
    const everyMinute = yield* makePeriodicGate(MINUTE_MS);
    yield* scheduler.register("project-team-goal-check", everyMinute(reactor.check));
  }),
).pipe(Layer.provide(layer));
