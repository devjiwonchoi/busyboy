import {
  CommandId,
  MessageId,
  type ProjectTask,
  type ProjectTaskEventId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { MINUTE_MS, isLeadBusy, isoMillis, makePeriodicGate, nowIso } from "./common.ts";

/** A stalled task the PM has not touched for this long gets the PM's attention. */
export const STALLED_TASK_NOTICE_MS = 10 * MINUTE_MS;
const SWEPT_STAGES = ["planning", "running", "in_review"] as const;
const EVENT_LOOKBACK = 50;

export function stalledNoticeText(tasks: ReadonlyArray<Pick<ProjectTask, "number">>): string {
  const list = tasks.map((task) => `#${task.number}`).join(", ");
  return `${tasks.length} ${tasks.length === 1 ? "task looks" : "tasks look"} stalled: ${list}. Check team_status.`;
}

export class StalledTaskSweep extends Context.Service<
  StalledTaskSweep,
  {
    /** One pass over every project; reads storage and wakes an idle PM only when needed. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/projectTeam/StalledTaskSweep") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Task id -> the outcome event the PM was already told about.
  const notified = yield* Ref.make<ReadonlyMap<string, ProjectTaskEventId>>(new Map());

  const sweepProject = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    Effect.gen(function* () {
      if (!manager.settings.enabled) return;
      const nowMs = isoMillis(yield* nowIso);
      const tasks = yield* repository.listTasks({
        projectId: manager.projectId,
        stages: SWEPT_STAGES,
      });
      const alreadyNotified = yield* Ref.get(notified);
      const found: Array<{
        readonly task: ProjectTask;
        readonly outcomeEventId: ProjectTaskEventId;
      }> = [];
      for (const task of tasks) {
        if (task.lastOutcome !== "stalled") continue;
        if (nowMs - isoMillis(task.stageChangedAt) <= STALLED_TASK_NOTICE_MS) continue;
        const events = yield* repository.listTaskEvents({ taskId: task.id, limit: EVENT_LOOKBACK });
        const outcome = events.findLast((event) => event.kind === "outcome");
        const nudge = events.findLast((event) => event.kind === "nudge");
        if (
          outcome === undefined ||
          alreadyNotified.get(task.id) === outcome.id ||
          nowMs - isoMillis(outcome.createdAt) <= STALLED_TASK_NOTICE_MS
        ) {
          continue;
        }
        if (nudge !== undefined && nowMs - isoMillis(nudge.createdAt) <= STALLED_TASK_NOTICE_MS) {
          continue;
        }
        // The lead resumed (a new run or delegated children at work) since it stalled.
        if (task.leadThreadId !== null && (yield* isLeadBusy(threads, task.leadThreadId))) {
          continue;
        }
        found.push({ task, outcomeEventId: outcome.id });
      }
      if (found.length === 0) return;
      const shell = yield* threads.getThreadShell(manager.threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      if (shell.activeRunId !== null) return;

      const key = `project-team:stalled:${manager.projectId}:${found
        .map((entry) => entry.outcomeEventId)
        .join(",")}`;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: manager.threadId,
        messageId: MessageId.make(key),
        text: stalledNoticeText(found.map((entry) => entry.task)),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* Ref.update(notified, (current) => {
        const next = new Map(current);
        for (const entry of found) next.set(entry.task.id, entry.outcomeEventId);
        return next;
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team stalled sweep failed", {
          projectId: manager.projectId,
          cause,
        }),
      ),
    );

  const sweep: StalledTaskSweep["Service"]["sweep"] = repository.listManagers().pipe(
    Effect.flatMap((managers) => Effect.forEach(managers, sweepProject, { discard: true })),
    Effect.catchCause((cause) => Effect.logWarning("project team stalled sweep failed", { cause })),
  );

  return { sweep } satisfies StalledTaskSweep["Service"];
});

export const layer = Layer.effect(StalledTaskSweep, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const stalled = yield* StalledTaskSweep;
    const scheduler = yield* Scheduler.Scheduler;
    const everyMinute = yield* makePeriodicGate(MINUTE_MS);
    yield* scheduler.register("project-team-stalled-sweep", everyMinute(stalled.sweep));
  }),
).pipe(Layer.provide(layer));
