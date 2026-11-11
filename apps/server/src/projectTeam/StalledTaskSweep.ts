/**
 * Once a minute, finds tasks that sit still when they could move, and moves them
 * or tells someone, at most once per stall:
 *
 * - A held task whose resume condition now holds: the hold ends and the PM is told
 *   to start it. Not started 10 minutes later, the user gets one message.
 * - A Todo task that could start (a free slot, nothing it waits on, not held) for
 *   10 minutes: the PM is told to start it; at 20 minutes, the user gets one message.
 * - A planning or running task whose lead stopped without finishing, asking or
 *   holding, including one that got the user's answer and did not move on: an
 *   answer the lead never picked up is sent again after 2 minutes; at 10 minutes
 *   the lead is woken once; at 20 minutes the user gets one message.
 *
 * Every such stall is recorded per task with its cause (see stallLedger.ts).
 * A wait on the user, a hold whose condition has not come, and a task the memory
 * governor holds are not stalls.
 */
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type ProjectAttentionItem,
  type ProjectTask,
  ProjectTaskEventId,
  type ProjectTaskStallCause,
  resolveTaskExecutionSettings,
  STALL_RESTART,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as MemoryHeadroom from "../resourceTelemetry/MemoryHeadroom.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import {
  isoFromMillis,
  isLeadBusy,
  isoMillis,
  makeIdGenerator,
  makePeriodicGate,
  MINUTE_MS,
  nowIso,
} from "./common.ts";
import { activeLocalLeads } from "./memoryPolicy.ts";
import {
  ANSWER_REDELIVER_AFTER_MS,
  holdConditionMet,
  leadWakeText,
  liveStallCause,
  resumeWhenText,
  STALL_CAUSE_LABELS,
  STALL_NOTIFY_AFTER_MS,
  STALL_WAKE_AFTER_MS,
  stallCard,
  stallMinutes,
} from "./stallLedger.ts";
import { nextInboxTask } from "./taskOutcomeReactor.ts";

const SWEPT_STAGES = ["inbox", "planning", "running"] as const;
const ANSWER_KINDS = ["decision", "blocker", "approval"] as const;

export class StalledTaskSweep extends Context.Service<
  StalledTaskSweep,
  {
    /** One pass over every project. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/projectTeam/StalledTaskSweep") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const router = yield* AttentionRouter.AttentionRouter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const memory = yield* MemoryHeadroom.MemoryHeadroom;
  const newId = yield* makeIdGenerator;
  // Answers already sent again, by attention item; at most once per answer.
  const redelivered = yield* Ref.make<ReadonlySet<string>>(new Set());

  const newKey = (prefix: string) => newId(prefix).pipe(Effect.orDie);
  const millisOf = (value: DateTime.Utc | null | undefined) =>
    value == null ? null : DateTime.toEpochMillis(value);

  const send = (threadId: ThreadId, key: string, text: string) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return false;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
      return true;
    }).pipe(Effect.orElseSucceed(() => false));

  const note = (task: ProjectTask, body: string) =>
    Effect.gen(function* () {
      yield* repository.appendTaskEvent({
        id: ProjectTaskEventId.make(yield* newKey("task-event")),
        projectId: task.projectId,
        taskId: task.id,
        kind: "note",
        body,
        actorThreadId: null,
        createdAt: yield* nowIso,
      });
    }).pipe(Effect.ignore);

  /** Raises the one user message for a stall and tells the PM in a line. */
  const notifyUser = (input: {
    readonly manager: ProjectTeamRepository.ProjectManagerRecord;
    readonly task: ProjectTask;
    readonly stall: ProjectTeamRepository.ProjectTaskStallRecord;
    readonly nowMs: number;
    readonly holdText?: string | null;
  }) =>
    Effect.gen(function* () {
      const { task, stall } = input;
      if (stall.cause === "start_failed") return;
      const minutes = stallMinutes(isoMillis(stall.startedAt), input.nowMs);
      const card = stallCard({
        cause: stall.cause,
        title: task.title,
        minutes,
        holdText: input.holdText ?? null,
      });
      // Lead stalls go back to the lead; a task nobody started goes to the PM.
      const toLead = stall.cause === "no_progress" || stall.cause === "answered_idle";
      // Marked first: a failure after this loses one card rather than sending two.
      const now = yield* nowIso;
      yield* repository.markTaskStall({ stallId: stall.stallId, notifiedAt: now });
      yield* router.ask({
        task,
        kind: "blocker",
        question: card.question,
        details: card.details,
        context: card.context,
        options: [STALL_RESTART],
        askerThreadId: toLead ? task.leadThreadId : input.manager.threadId,
        ...(toLead ? {} : { senderRole: "pm" as const, senderName: null }),
      });
      // From here the task waits on the user, which is not a stall.
      yield* repository.closeTaskStalls({ taskId: task.id, endedAt: now });
      yield* send(
        input.manager.threadId,
        `project-team:stall-notified:${stall.stallId}`,
        `#${task.number} ${task.title} is still stalled (${STALL_CAUSE_LABELS[stall.cause]}, ${minutes} min); the user got one message with ${STALL_RESTART}. Nothing else to do unless you can unblock it.`,
      );
    });

  const openStall = (task: ProjectTask, cause: ProjectTaskStallCause, startedAtMs: number) =>
    Effect.gen(function* () {
      return yield* repository.openTaskStall({
        stallId: yield* newKey("stall"),
        taskId: task.id,
        cause,
        startedAt: isoFromMillis(startedAtMs),
      });
    });

  /**
   * True when the user was already told about this same stall: one of this cause
   * that began at or after `sinceMs` ended with a message. Nothing has moved since,
   * so telling them again would only repeat the message.
   */
  const alreadyTold = (
    task: ProjectTask,
    causes: ReadonlyArray<ProjectTaskStallCause>,
    sinceMs: number,
  ) =>
    repository
      .listTaskStalls({ taskId: task.id })
      .pipe(
        Effect.map((stalls) =>
          stalls.some(
            (stall) =>
              causes.includes(stall.cause) &&
              stall.endedAt !== null &&
              stall.notifiedAt !== null &&
              isoMillis(stall.startedAt) >= sinceMs,
          ),
        ),
      );

  const closeStalls = (task: ProjectTask, open: ReadonlyArray<unknown>) =>
    open.length === 0
      ? Effect.void
      : Effect.gen(function* () {
          yield* repository.closeTaskStalls({ taskId: task.id, endedAt: yield* nowIso });
        });

  /** The user's latest answer on one of the task's cards to its lead, if any. */
  const latestAnswer = (task: ProjectTask) =>
    Effect.gen(function* () {
      let latest: ProjectAttentionItem | null = null;
      for (const kind of ANSWER_KINDS) {
        const answered = yield* repository.listAnsweredTaskAttentionItems({
          taskId: task.id,
          kind,
        });
        for (const item of answered) {
          if (item.answeredAt === null || item.askerThreadId !== task.leadThreadId) continue;
          if (latest === null || isoMillis(item.answeredAt) > isoMillis(latest.answeredAt!)) {
            latest = item;
          }
        }
      }
      return latest;
    });

  const sweepLiveTask = (
    manager: ProjectTeamRepository.ProjectManagerRecord,
    task: ProjectTask,
    open: ReadonlyArray<ProjectTeamRepository.ProjectTaskStallRecord>,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const lead = task.leadThreadId;
      if (lead === null) return;
      const shell = yield* threads.getThreadShell(lead).pipe(Effect.orElseSucceed(() => null));
      const progressAtMs = Math.max(
        isoMillis(task.stageChangedAt),
        millisOf(shell?.latestRunStartedAt) ?? 0,
        millisOf(shell?.latestRunCompletedAt) ?? 0,
      );
      const openCards = yield* repository.listOpenAttentionItems({
        projectId: task.projectId,
        taskId: task.id,
      });
      const answer = yield* latestAnswer(task);
      const stalled = liveStallCause({
        task,
        leadBusy: yield* isLeadBusy(threads, lead),
        openCards: openCards.length,
        progressAtMs,
        answeredAtMs: answer?.answeredAt == null ? null : isoMillis(answer.answeredAt),
      });
      // A start failure is closed by the next lead run or card, like any stall.
      if (stalled === null) return yield* closeStalls(task, open);
      // A stall of another cause ended: e.g. the lead ran, then stopped again.
      const other = open.filter((stall) => stall.cause !== stalled.cause);
      if (other.length > 0) yield* closeStalls(task, other);

      const idleMs = nowMs - stalled.sinceMs;
      if (
        stalled.cause === "answered_idle" &&
        answer !== null &&
        idleMs >= ANSWER_REDELIVER_AFTER_MS &&
        !(yield* Ref.get(redelivered)).has(answer.id)
      ) {
        // The relay may have been lost: send the answer again, once. The command id
        // is stable, so a restart that forgets this set cannot send it twice.
        yield* Ref.update(redelivered, (set) => new Set(set).add(answer.id));
        yield* send(
          lead,
          `project-team:answer-redeliver:${answer.id}`,
          `[답 다시 전달] 사용자가 답했는데 아직 반영되지 않았어요.\n질문: ${answer.question.split("\n")[0]}\n답: ${answer.answer}`,
        );
      }
      if (idleMs < STALL_WAKE_AFTER_MS) return;
      if (yield* alreadyTold(task, [stalled.cause], stalled.sinceMs)) return;
      const stall = yield* openStall(task, stalled.cause, stalled.sinceMs);
      if (stall.wokeAt === null) {
        yield* send(
          lead,
          `project-team:stall-wake:${stall.stallId}`,
          leadWakeText(stalled.cause === "answered_idle" ? "answered_idle" : "no_progress"),
        );
        yield* repository.markTaskStall({ stallId: stall.stallId, wokeAt: yield* nowIso });
        yield* note(
          task,
          `${STALL_CAUSE_LABELS[stalled.cause]}: 10분 넘게 진행이 없어 리드를 깨웠어요.`,
        );
      }
      if (idleMs >= STALL_NOTIFY_AFTER_MS && stall.notifiedAt === null) {
        yield* notifyUser({ manager, task, stall, nowMs });
      }
    });

  const sweepProject = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    Effect.gen(function* () {
      if (!manager.settings.enabled || manager.kind === "director") return;
      const nowMs = isoMillis(yield* nowIso);
      const tasks = yield* repository.listTasks({
        projectId: manager.projectId,
        stages: SWEPT_STAGES,
      });
      if (tasks.length === 0) return;
      const allTasks = yield* repository.listTasks({ projectId: manager.projectId });
      const stageById = new Map<string, ProjectTask["stage"]>(
        allTasks.map((task) => [task.id as string, task.stage] as const),
      );
      const titleById = new Map<string, string>(
        allTasks.map((task) => [task.id as string, task.title] as const),
      );
      const lookup = (id: string) =>
        Effect.gen(function* () {
          if (stageById.has(id)) return;
          const other = yield* repository.getTask(id as ProjectTask["id"]);
          if (Option.isSome(other)) {
            stageById.set(id, other.value.stage);
            titleById.set(id, other.value.title);
          }
        });
      for (const task of tasks) {
        if (task.hold?.resumeWhen.type === "task") yield* lookup(task.hold.resumeWhen.taskId);
        for (const id of task.waitsOn) yield* lookup(id);
      }

      // Which Todo task could start now: the next ready one, when a slot is free.
      const execution = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => resolveTaskExecutionSettings(settings.taskExecution)),
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.taskExecution),
      );
      const slotFree =
        (yield* activeLocalLeads(repository)) < execution.maxConcurrentSessions &&
        (execution.location !== "local_only" || (yield* memory.check).headroom === "ok");
      const startable = slotFree
        ? nextInboxTask(
            tasks.filter(
              (task) => task.stage === "inbox" && task.hold == null && task.memoryHold == null,
            ),
            stageById,
          )
        : null;

      for (const task of tasks) {
        const open = yield* repository.listOpenTaskStalls({ taskId: task.id });
        if (task.stage !== "inbox") {
          yield* sweepLiveTask(manager, task, open, nowMs);
          continue;
        }
        if (task.memoryHold != null) {
          yield* closeStalls(task, open);
          continue;
        }
        if (task.hold != null) {
          const hold = task.hold;
          if (!holdConditionMet(hold.resumeWhen, nowMs, (id) => stageById.get(id))) {
            yield* closeStalls(task, open);
            continue;
          }
          // The condition holds: the hold ends and the PM starts the task.
          const condition = resumeWhenText(hold.resumeWhen, (id) => titleById.get(id));
          yield* repository.setTaskHold({ id: task.id, hold: null, now: yield* nowIso });
          yield* note(task, `다시 시작 조건이 풀렸어요(${condition}). PM에게 시작하라고 알렸어요.`);
          const stall = yield* openStall(task, "hold_not_resumed", nowMs);
          yield* send(
            manager.threadId,
            `project-team:hold-met:${task.id}:${hold.since}`,
            `#${task.number} ${task.title}: its resume condition is met (${hold.resumeWhen.type === "user" ? "the user decided" : condition}). Start it now with task_start (taskId: ${task.id}).`,
          );
          yield* repository.markTaskStall({ stallId: stall.stallId, wokeAt: yield* nowIso });
          yield* router.publish(task.projectId);
          continue;
        }
        // A card the user has not answered yet is their turn, not a stall.
        const cards = yield* repository.listOpenAttentionItems({
          projectId: task.projectId,
          taskId: task.id,
        });
        if (cards.length > 0) {
          yield* closeStalls(task, open);
          continue;
        }
        const notResumed = open.find((stall) => stall.cause === "hold_not_resumed");
        if (notResumed !== undefined) {
          // With no free slot nothing could start it, so it is not a stall.
          if (!slotFree) {
            yield* closeStalls(task, open);
            continue;
          }
          // The PM was told when the condition came; a start ends this stall.
          if (
            nowMs - isoMillis(notResumed.startedAt) >= STALL_WAKE_AFTER_MS &&
            notResumed.notifiedAt === null
          ) {
            yield* notifyUser({ manager, task, stall: notResumed, nowMs });
          }
          continue;
        }
        if (startable === null || startable.number !== task.number) {
          yield* closeStalls(task, open);
          continue;
        }
        // Told once since it last moved: the user decides, so no more messages.
        // A message about its met resume condition counts too: it is the same Todo task.
        if (
          yield* alreadyTold(
            task,
            ["not_started", "hold_not_resumed"],
            isoMillis(task.stageChangedAt),
          )
        ) {
          continue;
        }
        const stall = yield* openStall(task, "not_started", nowMs);
        const waitedMs = nowMs - isoMillis(stall.startedAt);
        if (waitedMs >= STALL_WAKE_AFTER_MS && stall.wokeAt === null) {
          yield* send(
            manager.threadId,
            `project-team:not-started:${stall.stallId}`,
            `#${task.number} ${task.title} could start (a free slot, nothing it waits on) but has waited ${stallMinutes(isoMillis(stall.startedAt), nowMs)} minutes. Start it with task_start (taskId: ${task.id}), or hold it with task_update(stage: "inbox", hold) if it should wait.`,
          );
          yield* repository.markTaskStall({ stallId: stall.stallId, wokeAt: yield* nowIso });
        }
        if (waitedMs >= STALL_NOTIFY_AFTER_MS && stall.notifiedAt === null) {
          yield* notifyUser({ manager, task, stall, nowMs });
        }
      }
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
