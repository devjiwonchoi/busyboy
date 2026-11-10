/**
 * Keeps the Mac out of swap while task leads run, every few seconds:
 *
 * - critical: pause one local task session per pass (idle ones first, then
 *   the longest-running), judging each pass on a fresh, uncached sample, so a
 *   pause gets a few seconds to free memory before the next is weighed.
 *   Under local_first or cloud_first a Claude lead moves to the cloud instead.
 * - tight: pause idle sessions only.
 * - ok: resume paused sessions, last paused first, one per pass; then tell a
 *   PM to start the next task waiting for memory, one at a time.
 *
 * A pause holds the thread's queue, stops its turn and releases its provider
 * session, so the claude process exits. The worktree and the claude session
 * stay, and the next turn resumes the same session. PM and Director threads,
 * and any session the user opened in the last ten minutes, are never paused.
 * Under local_only nothing here moves work to the cloud.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  MessageId,
  type ProjectId,
  type ProjectTask,
  type ProjectTaskId,
  type ProjectTaskMemoryHold,
  type ProjectTaskStage,
  ProjectTaskEventId,
  resolveTaskExecutionSettings,
  type TaskExecutionLocationPolicy,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as LeadMoveGate from "../cloudLead/LeadMoveGate.ts";
import { leadControl } from "../cloudLead/TaskMover.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as MemoryHeadroom from "../resourceTelemetry/MemoryHeadroom.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import { MINUTE_MS, makeIdGenerator, makePeriodicGate, nowIso } from "./common.ts";
import { MEMORY_WAIT_REASON, pauseOrder, type SessionCandidate } from "./memoryPolicy.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { ACTIVE_TASK_STAGES } from "./SitrepScheduler.ts";
import { taskChildren } from "./taskChildren.ts";

export const MEMORY_GOVERNOR_INTERVAL_MS = 5_000;
/** A PM told to start a waiting task gets this long before it is told again. */
const WAITING_WAKE_COOLDOWN_MS = 2 * MINUTE_MS;
/** Stages whose lead may hold a live session. */
const LIVE_STAGES: ReadonlyArray<ProjectTaskStage> = [...ACTIVE_TASK_STAGES, "in_review"];

export const PAUSED_NOTE =
  "메모리가 부족해 세션을 잠시 멈췄어요. 여유가 생기면 같은 세션으로 이어가요.";
export const RESUMED_NOTE = "메모리 여유가 생겨 멈췄던 세션을 이어가요.";
export const RESUME_NOTICE = "[메모리] 메모리 여유가 생겨 이어서 진행해요.";
export const MOVING_NOTE = "이 Mac의 메모리가 부족해 리드를 클라우드로 옮겼어요.";

export const waitingStartText = (task: Pick<ProjectTask, "number" | "title">) =>
  `메모리 여유가 생겼어요. #${task.number} ${task.title} 을(를) 지금 task_start로 시작하세요. (${MEMORY_WAIT_REASON}로 기다리던 태스크)`;

interface Candidate extends SessionCandidate {
  readonly threadId: ThreadId;
  readonly task: ProjectTask;
  readonly title: string;
}

interface PausedSession {
  readonly threadId: ThreadId;
  readonly taskId: ProjectTaskId;
  readonly projectId: ProjectId;
  /** A turn was stopped, so the session is told to go on when it resumes. */
  readonly interrupted: boolean;
}

export class MemoryGovernor extends Context.Service<
  MemoryGovernor,
  {
    /** One pass: sample memory and pause, move, resume or start as needed. */
    readonly tick: Effect.Effect<void>;
    /** Threads paused for memory, in pause order. */
    readonly paused: Effect.Effect<ReadonlyArray<ThreadId>>;
  }
>()("t3/projectTeam/MemoryGovernor") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const team = yield* ProjectTeamService.ProjectTeamService;
  const router = yield* AttentionRouter.AttentionRouter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const memory = yield* MemoryHeadroom.MemoryHeadroom;
  const gate = yield* LeadMoveGate.LeadMoveGate;
  const sessions = yield* Effect.serviceOption(ProviderSessionManager.ProviderSessionManagerV2);
  const newId = yield* makeIdGenerator;
  const pausedRef = yield* Ref.make<ReadonlyArray<PausedSession>>([]);
  const wokenAt = yield* Ref.make<ReadonlyMap<ProjectTaskId, number>>(new Map());
  const started = yield* Ref.make(false);

  const newKey = (prefix: string) => newId(prefix).pipe(Effect.orDie);
  const control = (threadId: ThreadId) =>
    leadControl({ threads, gate, newKey }, threadId, "memory");

  const settings = serverSettings.getSettings.pipe(
    Effect.map((value) => resolveTaskExecutionSettings(value.taskExecution)),
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.taskExecution),
  );

  const note = (task: Pick<ProjectTask, "id" | "projectId">, body: string) =>
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

  const setHold = (
    task: Pick<ProjectTask, "id" | "projectId">,
    hold: ProjectTaskMemoryHold | null,
  ) =>
    Effect.gen(function* () {
      yield* repository.setTaskMemoryHold({ id: task.id, memoryHold: hold, now: yield* nowIso });
      yield* router.publish(task.projectId);
    }).pipe(Effect.ignore);

  /** The provider session behind the thread's current provider thread, if any. */
  const providerSessionOf = (shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      if (shell.activeProviderThreadId === null) return null;
      const { providerThreads } = yield* threads.getThreadRecords(shell.id, ["providerThreads"]);
      return (
        providerThreads.find((thread) => thread.id === shell.activeProviderThreadId)
          ?.providerSessionId ?? null
      );
    }).pipe(Effect.orElseSucceed(() => null));

  const toCandidate = (
    shell: OrchestrationV2ThreadShell,
    task: ProjectTask,
    kind: "lead" | "child",
  ) =>
    Effect.gen(function* () {
      const providerSessionId = yield* providerSessionOf(shell);
      const hasLiveSession =
        providerSessionId !== null && Option.isSome(sessions)
          ? yield* sessions.value.isLive(providerSessionId)
          : false;
      const millis = (value: DateTime.Utc | null | undefined) =>
        value == null ? null : DateTime.toEpochMillis(value);
      return {
        threadId: shell.id,
        task,
        title: shell.title,
        kind,
        running: shell.activeRunId !== null,
        runStartedAtMs: shell.activeRunId === null ? null : millis(shell.latestRunStartedAt),
        lastVisitedAtMs: millis(shell.lastVisitedAt),
        hasLiveSession,
      } satisfies Candidate;
    });

  /** Local task leads and their local children, minus held, moving and manager threads. */
  const candidates = Effect.gen(function* () {
    const managers = yield* repository.listManagers();
    const managerThreads = new Set<string>(managers.map((manager) => manager.threadId));
    const found: Array<Candidate> = [];
    for (const manager of managers) {
      const tasks = yield* repository.listTasks({
        projectId: manager.projectId,
        stages: LIVE_STAGES,
      });
      const local = tasks.filter(
        (task) =>
          task.leadThreadId !== null &&
          (task.location ?? "local") === "local" &&
          task.moveTarget == null,
      );
      if (local.length === 0) continue;
      const shells = yield* threads
        .listProjectThreads({ projectId: manager.projectId, includeSubagents: true })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []));
      for (const task of local) {
        const lead = shells.find((shell) => shell.id === task.leadThreadId);
        if (lead === undefined) continue;
        const sessionShells = [
          { shell: lead, kind: "lead" as const },
          ...taskChildren(shells, lead.id).map((shell) => ({ shell, kind: "child" as const })),
        ];
        for (const { shell, kind } of sessionShells) {
          if (managerThreads.has(shell.id) || gate.isHeld(shell.id)) continue;
          if (shell.location === "cloud") continue;
          found.push(yield* toCandidate(shell, task, kind));
        }
      }
    }
    return found;
  });

  const pause = (candidate: Candidate) =>
    Effect.gen(function* () {
      const threadId = candidate.threadId;
      gate.hold(threadId, "memory");
      const interrupted = yield* control(threadId).stopTurn.pipe(
        Effect.catch((error) =>
          Effect.logWarning("memory governor could not stop a turn", {
            threadId,
            detail: error.detail,
          }).pipe(Effect.as(false)),
        ),
      );
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      const providerSessionId = shell === null ? null : yield* providerSessionOf(shell);
      if (providerSessionId !== null && Option.isSome(sessions)) {
        yield* sessions.value
          .release({
            providerSessionId,
            reason: "memory_pressure",
            detail: "Paused while the Mac is short on memory.",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("memory governor could not release a session", {
                threadId,
                cause,
              }),
            ),
          );
      }
      yield* Ref.update(pausedRef, (all) => [
        ...all,
        { threadId, taskId: candidate.task.id, projectId: candidate.task.projectId, interrupted },
      ]);
      const current = yield* repository.getTask(candidate.task.id).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (current?.memoryHold !== "paused") {
        yield* setHold(candidate.task, "paused");
        yield* note(
          candidate.task,
          candidate.kind === "lead" ? PAUSED_NOTE : `${candidate.title}: ${PAUSED_NOTE}`,
        );
      }
      yield* Effect.logInfo("memory governor paused a session", { threadId, interrupted });
    });

  /** Moves a Claude lead to the cloud; false when that is not possible here. */
  const moveToCloud = (candidate: Candidate) =>
    team
      .moveTask({ projectId: candidate.task.projectId, taskId: candidate.task.id, to: "cloud" })
      .pipe(
        Effect.andThen(note(candidate.task, MOVING_NOTE)),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logInfo("memory governor could not move a lead; pausing it", {
            taskId: candidate.task.id,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );

  /** Frees one session; the next pass judges its effect on a fresh sample. */
  const relieve = (policy: TaskExecutionLocationPolicy, level: "tight" | "critical") =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const next = pauseOrder(yield* candidates, nowMs, level)[0];
      if (next === undefined) return;
      // local_only never reaches the cloud: it pauses.
      const moved =
        policy !== "local_only" && next.kind === "lead" ? yield* moveToCloud(next) : false;
      if (!moved) yield* pause(next);
    });

  /** Resumes the last paused session. */
  const resumeOne = Effect.gen(function* () {
    const paused = yield* Ref.get(pausedRef);
    const last = paused.at(-1);
    if (last === undefined) return false;
    const lead = control(last.threadId);
    if (last.interrupted) {
      yield* lead.tellLead(RESUME_NOTICE).pipe(Effect.ignore);
    }
    yield* lead.resumeQueue;
    const remaining = paused.slice(0, -1);
    yield* Ref.set(pausedRef, remaining);
    if (!remaining.some((entry) => entry.taskId === last.taskId)) {
      yield* setHold({ id: last.taskId, projectId: last.projectId }, null);
      yield* note({ id: last.taskId, projectId: last.projectId }, RESUMED_NOTE);
    }
    yield* Effect.logInfo("memory governor resumed a session", { threadId: last.threadId });
    return true;
  });

  const dependenciesCleared = (task: ProjectTask) =>
    Effect.gen(function* () {
      for (const id of task.waitsOn) {
        const dependency = yield* repository.getTask(id);
        if (Option.isNone(dependency)) continue;
        const stage = dependency.value.stage;
        if (stage !== "done" && stage !== "in_review") return false;
      }
      return true;
    });

  /** Tells the PM to start the lowest-numbered task waiting for memory, one at a time. */
  const startNextWaiting = Effect.gen(function* () {
    const held = yield* repository.listMemoryHeldTasks();
    const waiting: Array<ProjectTask> = [];
    for (const task of held) {
      if (task.memoryHold !== "waiting") continue;
      // Started, cancelled or moved on some other way: the hold no longer applies.
      if (task.stage !== "inbox") {
        yield* setHold(task, null);
        continue;
      }
      if (yield* dependenciesCleared(task)) waiting.push(task);
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const woken = yield* Ref.get(wokenAt);
    // One wake in flight at a time: once the PM started it, the next pass re-checks memory.
    if (
      waiting.some((task) => {
        const at = woken.get(task.id);
        return at !== undefined && nowMs - at < WAITING_WAKE_COOLDOWN_MS;
      })
    ) {
      return;
    }
    const execution = yield* settings;
    for (const task of waiting) {
      const manager = yield* repository.getManager(task.projectId);
      if (Option.isNone(manager) || !manager.value.settings.enabled) continue;
      const active = yield* repository.listTasks({
        projectId: task.projectId,
        stages: ACTIVE_TASK_STAGES,
      });
      const cap = execution.maxConcurrentSessions;
      if (active.length >= cap) continue;
      const pm = manager.value.threadId;
      const shell = yield* threads.getThreadShell(pm).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) continue;
      const key = yield* newKey(`project-team:memory-start:${task.id}`);
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId: pm,
          messageId: MessageId.make(key),
          text: waitingStartText(task),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.ignore);
      yield* Ref.update(wokenAt, (all) => new Map(all).set(task.id, nowMs));
      return;
    }
  });

  /** After a restart no session is held any more, so stale "paused" marks are cleared. */
  const clearStalePauses = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    for (const task of yield* repository.listMemoryHeldTasks()) {
      if (task.memoryHold === "paused") yield* setHold(task, null);
    }
  });

  const tick: MemoryGovernor["Service"]["tick"] = Effect.gen(function* () {
    yield* clearStalePauses;
    const execution = yield* settings;
    // Uncached: the last pass's pause must show in this reading.
    const { headroom } = yield* memory.checkFresh;
    if (headroom !== "ok") {
      yield* relieve(execution.location, headroom);
      // Waiting tasks start in the cloud when the user allows it.
      if (execution.location !== "local_only") yield* startNextWaiting;
      return;
    }
    // Paused sessions come back before anything new starts.
    if (yield* resumeOne) return;
    yield* startNextWaiting;
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("memory governor pass failed", { cause })),
  );

  return {
    tick,
    paused: Ref.get(pausedRef).pipe(Effect.map((all) => all.map((entry) => entry.threadId))),
  } satisfies MemoryGovernor["Service"];
});

export const layer = Layer.effect(MemoryGovernor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const governor = yield* MemoryGovernor;
    const scheduler = yield* Scheduler.Scheduler;
    const everyFewSeconds = yield* makePeriodicGate(MEMORY_GOVERNOR_INTERVAL_MS);
    yield* scheduler.register("project-team-memory-governor", everyFewSeconds(governor.tick));
  }),
).pipe(Layer.provide(layer));
