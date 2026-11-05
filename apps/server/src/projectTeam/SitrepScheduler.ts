import {
  CommandId,
  type IsoDateTime,
  MAX_PROJECT_TEAM_AUTO_SITREP_INTERVAL_MINUTES,
  MessageId,
  MIN_PROJECT_TEAM_AUTO_SITREP_INTERVAL_MINUTES,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  ProjectSitrepId,
  type ProjectSitrepReason,
  ProjectTaskEventId,
  type ProjectTeamError,
  type ProjectTeamQuietHours,
  type ProjectTeamSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import {
  MINUTE_MS,
  isoMillis,
  makeIdGenerator,
  makePeriodicGate,
  nowIso,
  orTeamError,
  teamError,
} from "./common.ts";

export const SITREP_MILESTONE_DEBOUNCE_MS = 3 * MINUTE_MS;
/** A user message this recent means the user is talking to the PM; the sitrep waits. */
export const SITREP_RECENT_USER_MESSAGE_MS = 2 * MINUTE_MS;
export const SITREP_UNREAD_STREAK_LIMIT = 3;
/** A sitrep the PM has not written after this long (while idle) is given up on. */
export const SITREP_PENDING_TIMEOUT_MS = 30 * MINUTE_MS;
export const ABANDONED_SITREP_BODY = "(No sitrep was posted.)";
const SITREP_NOW_REASON = "you asked for a sitrep before the next one was due";
const SITREP_MESSAGE_PREFIX = "project-team:sitrep:";
/** Task events that count as a change worth reporting. */
const REPORTABLE_EVENT_KINDS = new Set(["created", "stage_changed", "summary"]);
export const ACTIVE_TASK_STAGES = ["planning", "running"] as const;

export function preferenceChangedBody(minutes: number, reason: string): string {
  return `interval changed to ${minutes} min because ${reason}`;
}

/** An interval the user set by hand is never adapted. */
export function isPinned(settings: ProjectTeamSettings): boolean {
  return settings.intervalPinnedAt !== undefined;
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function isWithinQuietHours(
  quietHours: ProjectTeamQuietHours | undefined,
  localMinutes: number,
): boolean {
  if (quietHours === undefined) return false;
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  if (start === end) return false;
  return start < end
    ? localMinutes >= start && localMinutes < end
    : localMinutes >= start || localMinutes < end;
}

export function sitrepDueText(input: {
  readonly since: IsoDateTime;
  readonly reason: ProjectSitrepReason;
  readonly mentions: ReadonlyArray<string>;
}): string {
  const lines = [
    `[Sitrep due] since ${input.since}. Call team_status(since) and post a 3–6 line sitrep.`,
  ];
  if (input.reason === "liveness") {
    lines.push("Nothing changed; one line on what is still running is enough.");
  }
  if (input.reason === "requested") {
    lines.push("The user asked for this sitrep; post it even if nothing changed.");
  }
  for (const mention of input.mentions) lines.push(`Mention: ${mention}`);
  return lines.join("\n");
}

const localMinutesNow = DateTime.withCurrentZoneLocal(
  Effect.map(
    DateTime.nowInCurrentZone,
    (now) => DateTime.getPart(now, "hour") * 60 + DateTime.getPart(now, "minute"),
  ),
);

export class SitrepScheduler extends Context.Service<
  SitrepScheduler,
  {
    /** A task finished, a PR opened, or nothing is running any more. */
    readonly noteMilestone: (projectId: ProjectId) => Effect.Effect<void>;
    /** Sends a sitrep request now, or returns the one the PM is still writing. */
    readonly request: (projectId: ProjectId) => Effect.Effect<ProjectSitrepId, ProjectTeamError>;
    /** Closes the sitrep still being written, e.g. because the PM thread was replaced. */
    readonly abandonPending: (projectId: ProjectId) => Effect.Effect<void, ProjectTeamError>;
    /** Checks every project once and sends the sitreps that are due. */
    readonly check: Effect.Effect<void>;
    /** Tracks user messages, visits and finished sitrep turns on PM threads. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /**
     * Runs a read-modify-write of a project's settings JSON alone. Every settings write
     * goes through it, so re-read the PM inside. Not reentrant.
     */
    readonly withSettingsLock: <A, E, R>(
      projectId: ProjectId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/projectTeam/SitrepScheduler") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const router = yield* AttentionRouter.AttentionRouter;
  const newId = yield* makeIdGenerator;
  const milestoneDueAt = yield* Ref.make<ReadonlyMap<ProjectId, number>>(new Map());

  const requireManager = (projectId: ProjectId) =>
    repository.getManager(projectId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(teamError(`Project ${projectId} has no PM.`, projectId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const settingsLocks = yield* KeyedLock.make<ProjectId>();
  const withSettingsLock: SitrepScheduler["Service"]["withSettingsLock"] = (projectId, effect) =>
    settingsLocks.withLock(projectId, effect);

  /**
   * Adapts the interval from the stored settings, unless the user pinned it meanwhile.
   * `next` maps the current interval to the new one.
   */
  const changeInterval = (
    projectId: ProjectId,
    next: (interval: number) => number,
    reason: string,
  ) =>
    Effect.gen(function* () {
      const changed = yield* withSettingsLock(
        projectId,
        Effect.gen(function* () {
          const manager = yield* repository.getManager(projectId);
          if (Option.isNone(manager)) return false;
          const now = yield* nowIso;
          const settings = manager.value.settings;
          if (isPinned(settings)) return false;
          const minutes = next(settings.sitrepIntervalMinutes);
          if (minutes === settings.sitrepIntervalMinutes) return false;
          yield* repository.updateManagerSettings({
            projectId,
            settings: { ...settings, sitrepIntervalMinutes: minutes },
            now,
          });
          yield* repository.appendTaskEvent({
            id: ProjectTaskEventId.make(yield* newId("project-event")),
            projectId,
            taskId: null,
            kind: "preference_changed",
            body: preferenceChangedBody(minutes, reason),
            actorThreadId: null,
            createdAt: now,
          });
          return true;
        }),
      );
      if (changed) yield* router.publish(projectId);
    });

  const noteMilestone: SitrepScheduler["Service"]["noteMilestone"] = (projectId) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* Ref.update(milestoneDueAt, (current) =>
        current.has(projectId)
          ? current
          : new Map(current).set(
              projectId,
              DateTime.toEpochMillis(now) + SITREP_MILESTONE_DEBOUNCE_MS,
            ),
      );
    });

  /**
   * "Sitrep now" before the next one was due shortens an interval the user never set.
   * Chatting with the PM never changes it.
   */
  const shortenOnRequest = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const manager = yield* requireManager(projectId);
      const nowMs = isoMillis(yield* nowIso);
      if (isPinned(manager.settings)) return;
      const interval = manager.settings.sitrepIntervalMinutes;
      if (
        manager.lastSitrepAt !== null &&
        nowMs - isoMillis(manager.lastSitrepAt) <= (interval / 2) * MINUTE_MS
      ) {
        return;
      }
      // Pressing the button again in the same window halves only once.
      const events = yield* repository.listProjectEventsSince({
        projectId,
        since: manager.lastSitrepAt ?? manager.createdAt,
      });
      if (
        events.some(
          (event) => event.kind === "preference_changed" && event.body.endsWith(SITREP_NOW_REASON),
        )
      ) {
        return;
      }
      const halve = (current: number) =>
        Math.min(
          current,
          Math.max(MIN_PROJECT_TEAM_AUTO_SITREP_INTERVAL_MINUTES, Math.floor(current / 2)),
        );
      if (halve(interval) >= interval) return;
      yield* changeInterval(projectId, halve, SITREP_NOW_REASON);
    });

  const dispatchSitrep = (
    manager: ProjectTeamRepository.ProjectManagerRecord,
    reason: ProjectSitrepReason,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const windowStart = manager.lastSitrepAt ?? manager.createdAt;
      const mentions = (yield* repository.listProjectEventsSince({
        projectId: manager.projectId,
        since: windowStart,
      }))
        .filter((event) => event.kind === "preference_changed")
        .map((event) => event.body);
      const id = ProjectSitrepId.make(yield* newId("sitrep"));
      const key = `${SITREP_MESSAGE_PREFIX}${id}`;
      // The row goes in first so a crash after the dispatch cannot lose track of the request.
      yield* repository.createSitrep({
        id,
        projectId: manager.projectId,
        since: manager.lastSitrepAt,
        reason,
        createdAt: now,
      });
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId: manager.threadId,
          messageId: MessageId.make(key),
          text: sitrepDueText({ since: windowStart, reason, mentions }),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.tapError(() =>
            repository.setSitrepBody({ id, body: ABANDONED_SITREP_BODY }).pipe(Effect.ignore),
          ),
        );
      yield* Ref.update(milestoneDueAt, (current) => {
        const next = new Map(current);
        next.delete(manager.projectId);
        return next;
      });
      yield* router.publish(manager.projectId);
      return id;
    });

  /**
   * The latest sitrep, after giving up on one the PM has not written for too long
   * while idle (a crash, or a turn that never ran), so scheduling can resume.
   */
  const latestSitrep = (projectId: ProjectId, managerThreadId: ThreadId) =>
    Effect.gen(function* () {
      const latest = yield* repository.getLatestSitrep(projectId);
      if (Option.isNone(latest) || latest.value.body !== null) return latest;
      const nowMs = isoMillis(yield* nowIso);
      if (nowMs - isoMillis(latest.value.createdAt) <= SITREP_PENDING_TIMEOUT_MS) return latest;
      const shell = yield* threads.getThreadShell(managerThreadId);
      if (shell !== null && shell.activeRunId !== null) return latest;
      const closed = yield* repository.setSitrepBody({
        id: latest.value.id,
        body: ABANDONED_SITREP_BODY,
      });
      yield* router.publish(projectId);
      return closed;
    });

  const abandonPending: SitrepScheduler["Service"]["abandonPending"] = (projectId) =>
    Effect.gen(function* () {
      const latest = yield* repository.getLatestSitrep(projectId);
      if (Option.isNone(latest) || latest.value.body !== null) return;
      yield* repository.setSitrepBody({ id: latest.value.id, body: ABANDONED_SITREP_BODY });
      yield* router.publish(projectId);
    }).pipe(orTeamError("Could not close the pending sitrep.", projectId));

  const request: SitrepScheduler["Service"]["request"] = (projectId) =>
    Effect.gen(function* () {
      const manager = yield* requireManager(projectId);
      const latest = yield* latestSitrep(projectId, manager.threadId);
      if (Option.isSome(latest) && latest.value.body === null) return latest.value.id;
      yield* shortenOnRequest(projectId);
      return yield* dispatchSitrep(yield* requireManager(projectId), "requested");
    }).pipe(orTeamError("Could not request a sitrep.", projectId));

  const hasChangesSince = (projectId: ProjectId, since: IsoDateTime) =>
    Effect.gen(function* () {
      const events = yield* repository.listProjectEventsSince({ projectId, since });
      if (events.some((event) => REPORTABLE_EVENT_KINDS.has(event.kind))) return true;
      const items = yield* repository.listAttentionItemsSince({ projectId, since });
      return items.length > 0;
    });

  const checkProject = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    Effect.gen(function* () {
      // A turned-off PM keeps its thread but sends no sitreps until it is turned back on.
      if (!manager.settings.enabled) return;
      const shell = yield* threads.getThreadShell(manager.threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      const latest = yield* latestSitrep(manager.projectId, manager.threadId);
      if (Option.isSome(latest) && latest.value.body === null) return;

      const nowMs = isoMillis(yield* nowIso);
      const windowStart = manager.lastSitrepAt ?? manager.createdAt;
      // Time counts from the latest attempt, so an empty or failed sitrep waits a full
      // interval before the next one instead of retrying every minute.
      const elapsed =
        nowMs -
        Math.max(
          isoMillis(windowStart),
          Option.isSome(latest) ? isoMillis(latest.value.createdAt) : 0,
        );
      const intervalMs = manager.settings.sitrepIntervalMinutes * MINUTE_MS;
      const dueAt = (yield* Ref.get(milestoneDueAt)).get(manager.projectId);

      // Automatic sitreps never come closer together than the interval the user sees;
      // a milestone only makes the next one due even when nothing else changed.
      if (elapsed < intervalMs) return;
      let reason: ProjectSitrepReason | null = null;
      if (dueAt !== undefined && nowMs >= dueAt) {
        reason = "milestone";
      } else if (yield* hasChangesSince(manager.projectId, windowStart)) {
        reason = "interval";
      } else if (elapsed >= 2 * intervalMs) {
        const active = yield* repository.listTasks({
          projectId: manager.projectId,
          stages: ACTIVE_TASK_STAGES,
        });
        if (active.length > 0) reason = "liveness";
      }
      if (reason === null) return;

      if (
        manager.lastUserMessageAt !== null &&
        nowMs - isoMillis(manager.lastUserMessageAt) < SITREP_RECENT_USER_MESSAGE_MS
      ) {
        return;
      }
      if (isWithinQuietHours(manager.settings.quietHours, yield* localMinutesNow)) return;
      if (shell.activeRunId !== null) return;
      yield* dispatchSitrep(manager, reason);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team sitrep check failed", {
          projectId: manager.projectId,
          cause,
        }),
      ),
    );

  const check: SitrepScheduler["Service"]["check"] = repository.listManagers().pipe(
    Effect.flatMap((managers) => Effect.forEach(managers, checkProject, { discard: true })),
    Effect.catchCause((cause) => Effect.logWarning("project team sitrep check failed", { cause })),
  );

  const recordPostedSitrep = (
    manager: ProjectTeamRepository.ProjectManagerRecord,
    sitrepId: ProjectSitrepId,
    runId: NonNullable<OrchestrationV2DomainEvent["runId"]>,
  ) =>
    Effect.gen(function* () {
      const latest = yield* repository.getLatestSitrep(manager.projectId);
      if (Option.isNone(latest) || latest.value.id !== sitrepId || latest.value.body !== null) {
        return;
      }
      const { messages } = yield* threads.getThreadRecords(manager.threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
      });
      const body =
        messages
          .filter((message) => message.text.trim().length > 0)
          .toSorted(
            (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
          )
          .at(-1)
          ?.text.trim() ?? "";
      yield* repository.setSitrepBody({ id: sitrepId, body: body || ABANDONED_SITREP_BODY });
      // Only a posted sitrep moves the window and counts toward the unread streak.
      if (body.length > 0) {
        const now = yield* nowIso;
        // The window ends when the sitrep was requested, so changes made while the PM
        // was writing it land in the next one.
        const posted = yield* repository.recordSitrepPosted({
          projectId: manager.projectId,
          at: latest.value.createdAt,
        });
        if (
          Option.isSome(posted) &&
          posted.value.unreadSitrepStreak >= SITREP_UNREAD_STREAK_LIMIT &&
          !isPinned(posted.value.settings)
        ) {
          yield* repository.setUnreadSitrepStreak({
            projectId: manager.projectId,
            streak: 0,
            now,
          });
          yield* changeInterval(
            manager.projectId,
            (current) =>
              Math.max(
                current,
                Math.min(MAX_PROJECT_TEAM_AUTO_SITREP_INTERVAL_MINUTES, current * 2),
              ),
            `the last ${SITREP_UNREAD_STREAK_LIMIT} sitreps went unanswered`,
          );
        }
      }
      yield* router.publish(manager.projectId);
    });

  const handle: SitrepScheduler["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      const isUserMessage =
        event.type === "message.updated" &&
        event.payload.role === "user" &&
        event.payload.createdBy === "user" &&
        event.payload.creationSource !== "server";
      const isSettledRun =
        event.type === "run.updated" &&
        ThreadManagement.isTerminalRunStatus(event.payload.status) &&
        event.payload.userMessageId.startsWith(SITREP_MESSAGE_PREFIX);
      if (!isUserMessage && !isSettledRun && event.type !== "thread.visited") return;
      const manager = yield* repository.getManagerByThreadId(event.threadId);
      if (Option.isNone(manager)) return;
      const projectId = manager.value.projectId;

      if (event.type === "message.updated") {
        const at = DateTime.formatIso(event.payload.createdAt);
        yield* repository.recordUserMessage({ projectId, at });
        yield* repository.markSitrepsRead({ projectId, readAt: at });
        yield* router.publish(projectId);
        return;
      }
      if (event.type === "thread.visited") {
        const read = yield* repository.markSitrepsRead({ projectId, readAt: yield* nowIso });
        if (read > 0) yield* router.publish(projectId);
        return;
      }
      if (event.type === "run.updated") {
        const sitrepId = ProjectSitrepId.make(
          event.payload.userMessageId.slice(SITREP_MESSAGE_PREFIX.length),
        );
        yield* recordPostedSitrep(manager.value, sitrepId, event.payload.id);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team sitrep event failed", { threadId: event.threadId, cause }),
      ),
    );

  return {
    noteMilestone,
    request,
    abandonPending,
    check,
    handle,
    withSettingsLock,
  } satisfies SitrepScheduler["Service"];
});

export const layer = Layer.effect(SitrepScheduler, make);

/** Checks for due sitreps every minute and follows PM thread events. */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const sitreps = yield* SitrepScheduler;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const everyMinute = yield* makePeriodicGate(MINUTE_MS);
    yield* scheduler.register("project-team-sitrep", everyMinute(sitreps.check));
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, sitreps.handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team sitrep event stream failed", { cause }),
        ),
      ),
    );
  }),
);
