/**
 * The memory policy for task sessions, as pure decisions: whether a task lead
 * may start and where, and which sessions to pause first when the Mac is short
 * on memory. MemoryGovernor and the services that start work apply them.
 *
 * `local_only` never sends or moves work to the cloud: short on memory, work
 * waits instead.
 */
import {
  type ExecutionLocation,
  LEGACY_PROJECT_TEAM_MAX_CONCURRENT_TASKS,
  type TaskExecutionLocationPolicy,
} from "@t3tools/contracts";

import type { Headroom } from "../resourceTelemetry/MemoryHeadroom.ts";

/** What a task waiting for memory shows as its reason. */
export const MEMORY_WAIT_REASON = "메모리 여유 부족";
/** A session the user looked at this recently is never paused. */
export const RECENT_VISIT_MS = 10 * 60_000;

export const FORCED_LOCAL_NOTE =
  "실행 위치 설정이 '로컬만'이라 클라우드 대신 이 Mac에서 시작했어요. 클라우드 사용은 사용자가 설정에서 정해요.";
export const STARTED_IN_CLOUD_NOTE = "이 Mac의 메모리 여유가 부족해 클라우드에서 시작했어요.";

/**
 * How many task leads a project may run at once. The project's own limit only
 * counts when it was set below the old default; the user's safety cap always does.
 */
export function leadCap(projectMaxConcurrentTasks: number, maxConcurrentSessions: number): number {
  const project =
    projectMaxConcurrentTasks === LEGACY_PROJECT_TEAM_MAX_CONCURRENT_TASKS
      ? Number.POSITIVE_INFINITY
      : projectMaxConcurrentTasks;
  return Math.min(project, maxConcurrentSessions);
}

export type LeadAdmission =
  | {
      readonly type: "start";
      readonly location: ExecutionLocation;
      /** A short task note explaining the place, or null. */
      readonly note: string | null;
    }
  | {
      readonly type: "wait";
      readonly reason: string;
      /** True when memory, not the cap, holds it back. */
      readonly memory: boolean;
    };

export function admitTaskLead(input: {
  readonly active: number;
  readonly cap: number;
  readonly policy: TaskExecutionLocationPolicy;
  readonly headroom: Headroom;
  /** The PM's choice, if any. */
  readonly requested?: ExecutionLocation | undefined;
}): LeadAdmission {
  if (input.active >= input.cap) {
    return {
      type: "wait",
      reason: `${input.active} of ${input.cap} task leads are already running.`,
      memory: false,
    };
  }
  switch (input.policy) {
    case "local_only":
      if (input.headroom !== "ok") {
        return { type: "wait", reason: MEMORY_WAIT_REASON, memory: true };
      }
      return {
        type: "start",
        location: "local",
        note: input.requested === "cloud" ? FORCED_LOCAL_NOTE : null,
      };
    case "cloud_first":
      return { type: "start", location: "cloud", note: null };
    case "local_first":
      if (input.headroom !== "ok") {
        return { type: "start", location: "cloud", note: STARTED_IN_CLOUD_NOTE };
      }
      return { type: "start", location: input.requested ?? "local", note: null };
  }
}

/** A local session the governor could pause to free memory. */
export interface SessionCandidate {
  readonly threadId: string;
  readonly kind: "lead" | "child";
  /** A turn is running now. */
  readonly running: boolean;
  /** When the running turn started; null when unknown or idle. */
  readonly runStartedAtMs: number | null;
  readonly lastVisitedAtMs: number | null;
  /** Its provider process is alive, so pausing it frees memory even when idle. */
  readonly hasLiveSession: boolean;
}

/**
 * The sessions to pause, best first: idle ones, then running ones by longest
 * current run. Recently visited sessions and ones with nothing to free are left
 * out, and when memory is only tight, running sessions are left alone too.
 */
export function pauseOrder<C extends SessionCandidate>(
  candidates: ReadonlyArray<C>,
  nowMs: number,
  headroom: Exclude<Headroom, "ok">,
): ReadonlyArray<C> {
  return candidates
    .filter(
      (candidate) =>
        (candidate.lastVisitedAtMs === null ||
          nowMs - candidate.lastVisitedAtMs > RECENT_VISIT_MS) &&
        (candidate.running || candidate.hasLiveSession) &&
        (headroom === "critical" || !candidate.running),
    )
    .toSorted((left, right) => {
      if (left.running !== right.running) return left.running ? 1 : -1;
      return (left.runStartedAtMs ?? 0) - (right.runStartedAtMs ?? 0);
    });
}
