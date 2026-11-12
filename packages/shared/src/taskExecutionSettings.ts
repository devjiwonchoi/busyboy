import type {
  HostMemoryPressure,
  HostResourcesSnapshot,
  ProjectTaskMemoryHold,
  TaskExecutionLocationPolicy,
  TaskExecutionSettings,
} from "@t3tools/contracts";

/** The settings show memory in GB; the server stores bytes (1 GB = 1024³ bytes, as macOS reports). */
const BYTES_PER_GB = 1024 * 1024 * 1024;

export const TASK_EXECUTION_MEMORY_MIN_GB = 0.1;
export const TASK_EXECUTION_MEMORY_MAX_GB = 64;
export const TASK_EXECUTION_MEMORY_STEP_GB = 0.25;

export const TASK_EXECUTION_LOCATION_OPTIONS: ReadonlyArray<{
  readonly value: TaskExecutionLocationPolicy;
  readonly label: string;
}> = [
  { value: "local_only", label: "로컬만" },
  { value: "local_first", label: "로컬 우선, 모자라면 클라우드" },
  { value: "cloud_first", label: "클라우드 우선" },
];

export function taskExecutionLocationLabel(location: TaskExecutionLocationPolicy): string {
  return TASK_EXECUTION_LOCATION_OPTIONS.find((option) => option.value === location)?.label ?? "";
}

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 100) / 100;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_GB);
}

/** One decimal, without a trailing ".0": 2.1, 0.7, 2. */
function formatGb(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_GB) * 10) / 10);
}

const PRESSURE_LABELS: Record<HostMemoryPressure, string> = {
  normal: "보통",
  warn: "빠듯",
  critical: "위험",
};

/** "지금: 여유 2.1 GB · 스왑 0.7 / 2 GB · 보통"; swap and pressure drop out when the host does not report them. */
export function formatTaskExecutionMemoryStatus(
  snapshot: Pick<
    HostResourcesSnapshot,
    "availableMemoryBytes" | "memoryPressure" | "swapUsedBytes" | "swapTotalBytes"
  >,
): string {
  const parts = [`여유 ${formatGb(snapshot.availableMemoryBytes)} GB`];
  if (snapshot.swapUsedBytes !== undefined && snapshot.swapTotalBytes !== undefined) {
    parts.push(
      `스왑 ${formatGb(snapshot.swapUsedBytes)} / ${formatGb(snapshot.swapTotalBytes)} GB`,
    );
  }
  if (snapshot.memoryPressure !== undefined) {
    parts.push(PRESSURE_LABELS[snapshot.memoryPressure]);
  }
  return `지금: ${parts.join(" · ")}`;
}

export interface TaskExecutionMemoryDraft {
  readonly startMinFreeGb: number;
  readonly pauseBelowFreeGb: number;
}

export type TaskExecutionMemoryPatch =
  | {
      readonly ok: true;
      readonly patch: {
        readonly taskExecution: Pick<
          TaskExecutionSettings,
          "startMinFreeBytes" | "pauseBelowFreeBytes"
        >;
      };
    }
  | { readonly ok: false; readonly message: string };

/**
 * Turns the two GB fields into a settings patch. Both thresholds go together so
 * the server checks the pair; a pause threshold at or above the start one is
 * rejected here with the inline message instead.
 */
export function planTaskExecutionMemoryPatch(
  draft: TaskExecutionMemoryDraft,
): TaskExecutionMemoryPatch {
  const { startMinFreeGb, pauseBelowFreeGb } = draft;
  if (
    !Number.isFinite(startMinFreeGb) ||
    !Number.isFinite(pauseBelowFreeGb) ||
    startMinFreeGb < TASK_EXECUTION_MEMORY_MIN_GB ||
    pauseBelowFreeGb < TASK_EXECUTION_MEMORY_MIN_GB ||
    startMinFreeGb > TASK_EXECUTION_MEMORY_MAX_GB ||
    pauseBelowFreeGb > TASK_EXECUTION_MEMORY_MAX_GB
  ) {
    return {
      ok: false,
      message: `${TASK_EXECUTION_MEMORY_MIN_GB} GB에서 ${TASK_EXECUTION_MEMORY_MAX_GB} GB 사이로 정해 주세요.`,
    };
  }
  if (pauseBelowFreeGb >= startMinFreeGb) {
    return { ok: false, message: "멈추는 기준은 시작 기준보다 작아야 해요." };
  }
  return {
    ok: true,
    patch: {
      taskExecution: {
        startMinFreeBytes: gbToBytes(startMinFreeGb),
        pauseBelowFreeBytes: gbToBytes(pauseBelowFreeGb),
      },
    },
  };
}

/**
 * The sidebar label for a task held for memory, waiting to start or paused, or
 * null when it is not held. Web and mobile show the same quiet text.
 */
export function memoryHoldLabel(hold: ProjectTaskMemoryHold | null | undefined): string | null {
  return hold == null ? null : "메모리 대기";
}
