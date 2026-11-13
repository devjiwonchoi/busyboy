import {
  type IsoDateTime,
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProjectTeamError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const MINUTE_MS = 60_000;

export const nowIso: Effect.Effect<IsoDateTime> = Effect.map(DateTime.now, DateTime.formatIso);

export const isoMillis = (iso: IsoDateTime): number => Date.parse(iso);

export const isoFromMillis = (millis: number): IsoDateTime =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const isProjectTeamError = Schema.is(ProjectTeamError);

export const teamError = (message: string, projectId?: ProjectId) =>
  new ProjectTeamError({ message, ...(projectId === undefined ? {} : { projectId }) });

/** Wraps any failure in a ProjectTeamError that keeps the cause. */
export const orTeamError =
  (message: string, projectId?: ProjectId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ProjectTeamError, R> =>
    Effect.mapError(effect, (cause) =>
      isProjectTeamError(cause)
        ? cause
        : new ProjectTeamError({
            message,
            ...(projectId === undefined ? {} : { projectId }),
            cause,
          }),
    );

export const makeIdGenerator = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return (prefix: string): Effect.Effect<string, ProjectTeamError> =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => `${prefix}:${uuid}`),
      orTeamError("Could not generate an id."),
    );
});

/** Runs `effect` at most once per `periodMs`; the Scheduler ticks more often than that. */
export const makePeriodicGate = (periodMs: number) =>
  Effect.gen(function* () {
    const lastRun = yield* Ref.make<number | null>(null);
    return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, E, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(lastRun);
        if (last !== null && now - last < periodMs) return;
        yield* Ref.set(lastRun, now);
        yield* effect;
      });
  });

/**
 * Whether a task lead is still working even though a turn just ended: it has another
 * run in flight, delegated children of its own that have not settled, or background
 * work the provider still runs for it (a background subagent, command or monitor).
 * `endedRunId` is the run that just ended, which the shell may still report as active.
 * A failed read counts as idle so the caller falls back to its normal handling.
 * `ignoreBackgroundWork` skips the background check for callers that must not wait on a
 * long-lived background command, such as cleanup after a task is done.
 */
export const isLeadBusy = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  leadThreadId: ThreadId,
  endedRunId?: string,
  options?: { readonly ignoreBackgroundWork?: boolean },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const shell = yield* threads.getThreadShell(leadThreadId);
    if (shell !== null && shell.activeRunId !== null && shell.activeRunId !== endedRunId) {
      return true;
    }
    if (
      options?.ignoreBackgroundWork !== true &&
      shell !== null &&
      (shell.pendingBackgroundTasks?.length ?? 0) > 0
    ) {
      return true;
    }
    const { subagents } = yield* threads.getThreadRecords(leadThreadId, ["subagents"]);
    return subagents.some(
      (child) => child.origin === "app_owned" && isOrchestrationV2WorkActive(child.status),
    );
  }).pipe(Effect.orElseSucceed(() => false));

/** Watching a linked pull request; BusyBoy wakes the lead on its events, so it is not work. */
const isPullRequestWatch = (taskId: string) => taskId.startsWith("pull-request-watch:");

/**
 * Whether the background work a thread's provider runs for it (a background subagent,
 * command or monitor) is still alive: it showed activity within `freshWithinMs`.
 * A session that closed under its work, e.g. one paused for memory, leaves that work
 * marked running with no further updates, so a stale record is not live work.
 * `lastActivityAtMs` is the latest activity seen, or null when there is no such work.
 * A watched pull request is not work. A failed read counts as no work.
 */
export const liveBackgroundWork = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
  freshWithinMs: number,
): Effect.Effect<{ readonly live: boolean; readonly lastActivityAtMs: number | null }> =>
  Effect.gen(function* () {
    const pending = (shell.pendingBackgroundTasks ?? []).filter(
      (task) => !isPullRequestWatch(task.taskId),
    );
    if (pending.length === 0) return { live: false, lastActivityAtMs: null };
    const { subagents, turnItems } = yield* threads.getThreadRecords(
      shell.id,
      ["subagents", "turnItems"],
      {
        turnItemTypes: ["subagent", "command_execution", "dynamic_tool"],
        turnItemStatuses: ["pending", "running", "waiting"],
      },
    );
    const times = [
      ...subagents
        .filter(
          (child) =>
            child.origin === "provider_native" && isOrchestrationV2WorkActive(child.status),
        )
        .map((child) => child.updatedAt),
      ...turnItems
        .filter((item) => isOrchestrationV2WorkActive(item.status))
        .map((item) => item.updatedAt),
      // Work the provider lists without a record of its own started by the last turn's end.
      shell.latestRunCompletedAt,
    ].flatMap((at) => (at == null ? [] : [DateTime.toEpochMillis(at)]));
    const lastActivityAtMs = times.length === 0 ? null : Math.max(...times);
    return {
      live: lastActivityAtMs !== null && nowMs - lastActivityAtMs < freshWithinMs,
      lastActivityAtMs,
    };
  }).pipe(Effect.orElseSucceed(() => ({ live: false, lastActivityAtMs: null })));
