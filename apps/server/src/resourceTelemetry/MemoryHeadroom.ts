/**
 * How much room the Mac has for another agent session, judged from free
 * memory and the OS memory pressure level, with swap as an escalator under
 * warn pressure.
 *
 * - ok: a new session may start locally, and paused ones may resume.
 * - tight: start nothing new locally; idle sessions may be released.
 * - critical: release sessions until it is not critical any more.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type HostResourcesSnapshot,
  resolveTaskExecutionSettings,
  type TaskExecutionSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../serverSettings.ts";
import * as HostResources from "./HostResources.ts";

export type Headroom = "ok" | "tight" | "critical";

/**
 * Below this much swap free, warn pressure counts as critical. macOS keeps swap
 * nearly full long after pressure ends, so swap alone never makes it short.
 */
export const SWAP_CRITICAL_FREE_RATIO = 0.05;
export const MEMORY_SAMPLE_INTERVAL_MS = 5_000;

export type MemorySnapshot = Pick<
  HostResourcesSnapshot,
  "availableMemoryBytes" | "memoryPressure" | "swapUsedBytes" | "swapTotalBytes"
>;

function swapFreeRatio(snapshot: MemorySnapshot): number | null {
  const total = snapshot.swapTotalBytes;
  const used = snapshot.swapUsedBytes;
  if (total === undefined || used === undefined || total <= 0) return null;
  return Math.max(0, total - used) / total;
}

export function judgeHeadroom(
  snapshot: MemorySnapshot,
  settings: Pick<TaskExecutionSettings, "startMinFreeBytes" | "pauseBelowFreeBytes">,
): Headroom {
  const pressure = snapshot.memoryPressure ?? "normal";
  const swapFree = swapFreeRatio(snapshot);
  // Swap only escalates pressure the OS already reports.
  const swapExhausted = swapFree !== null && swapFree < SWAP_CRITICAL_FREE_RATIO;
  if (
    snapshot.availableMemoryBytes < settings.pauseBelowFreeBytes ||
    pressure === "critical" ||
    (pressure === "warn" && swapExhausted)
  ) {
    return "critical";
  }
  if (snapshot.availableMemoryBytes >= settings.startMinFreeBytes && pressure === "normal") {
    return "ok";
  }
  return "tight";
}

export interface MemoryReading {
  readonly headroom: Headroom;
  readonly snapshot: MemorySnapshot | null;
}

export interface MemoryHeadroomShape {
  /** Samples now; the host may answer from a sample a few seconds old. */
  readonly check: Effect.Effect<MemoryReading>;
  /** Samples now, never from a cached sample: for judging the effect of a pause. */
  readonly checkFresh: Effect.Effect<MemoryReading>;
  /** The last sample, for synchronous callers; null before the first one. */
  readonly latest: () => MemoryReading | null;
  /** The headroom each time it changes, sampled every few seconds. */
  readonly changes: Stream.Stream<Headroom>;
}

const UNLIMITED: MemoryReading = { headroom: "ok", snapshot: null };

/** No sampler: always ok, so code run without one behaves as before. */
export const unlimited: MemoryHeadroomShape = {
  check: Effect.succeed(UNLIMITED),
  checkFresh: Effect.succeed(UNLIMITED),
  latest: () => UNLIMITED,
  changes: Stream.make("ok" as const),
};

export class MemoryHeadroom extends Context.Reference<MemoryHeadroomShape>(
  "t3/resourceTelemetry/MemoryHeadroom",
  { defaultValue: () => unlimited },
) {}

/**
 * Judges samples from `read` against the user's thresholds. Tests pass a fake
 * `read`; `sampleEveryMs` null skips the background sampling.
 */
export const make = (input: {
  readonly read: Effect.Effect<MemorySnapshot>;
  /** An uncached read; defaults to `read`. */
  readonly readFresh?: Effect.Effect<MemorySnapshot>;
  readonly settings: Effect.Effect<TaskExecutionSettings>;
  readonly sampleEveryMs?: number | null;
}) =>
  Effect.gen(function* () {
    let latest: MemoryReading | null = null;
    const current = yield* SubscriptionRef.make<Headroom>("ok");
    const judge = (read: Effect.Effect<MemorySnapshot>) =>
      Effect.gen(function* () {
        const snapshot = yield* read;
        const settings = resolveTaskExecutionSettings(yield* input.settings);
        const reading = { headroom: judgeHeadroom(snapshot, settings), snapshot };
        latest = reading;
        yield* SubscriptionRef.set(current, reading.headroom);
        return reading;
      });
    const check = judge(input.read);
    const every =
      input.sampleEveryMs === undefined ? MEMORY_SAMPLE_INTERVAL_MS : input.sampleEveryMs;
    if (every !== null) {
      yield* check.pipe(
        Effect.catchCause((cause) => Effect.logWarning("memory headroom sample failed", { cause })),
        Effect.repeat(Schedule.spaced(every)),
        Effect.forkScoped,
      );
    }
    return {
      check,
      checkFresh: judge(input.readFresh ?? input.read),
      latest: () => latest,
      changes: SubscriptionRef.changes(current).pipe(Stream.changes),
    } satisfies MemoryHeadroomShape;
  });

const taskExecutionSettings = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  return settings.getSettings.pipe(
    Effect.map((value) => value.taskExecution),
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.taskExecution),
  );
});

/** Samples the host every few seconds. */
export const layer = Layer.effect(
  MemoryHeadroom,
  Effect.gen(function* () {
    const host = yield* HostResources.HostResources;
    return yield* make({
      read: host.read,
      readFresh: host.readFresh,
      settings: yield* taskExecutionSettings,
    });
  }),
);

/** For tests: samples come from `read`, only when asked. */
export const layerFromSource = (read: () => MemorySnapshot) =>
  Layer.effect(
    MemoryHeadroom,
    Effect.gen(function* () {
      return yield* make({
        read: Effect.sync(read),
        settings: yield* taskExecutionSettings,
        sampleEveryMs: null,
      });
    }),
  );

/** How long new local work waits for memory before giving up. */
export const HEADROOM_WAIT_MS = 3 * 60_000;

/**
 * Waits until there is room for a new local session, re-sampling every
 * `pollMs`. True once there is, false when `timeoutMs` passed first.
 */
export const waitForHeadroom = (
  memory: MemoryHeadroomShape,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pollMs = options.pollMs ?? MEMORY_SAMPLE_INTERVAL_MS;
    const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? HEADROOM_WAIT_MS) / pollMs));
    for (let attempt = 0; ; attempt += 1) {
      if ((yield* memory.check).headroom === "ok") return true;
      if (attempt >= attempts) return false;
      yield* Effect.sleep(pollMs);
    }
  });
