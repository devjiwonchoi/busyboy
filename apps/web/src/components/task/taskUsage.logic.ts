import {
  PROJECT_TASK_MODEL_ROLES,
  type ProjectTaskMetrics,
  type ProjectTaskSize,
  type ProjectTaskStepUsage,
  type ProjectTaskStepUsages,
} from "@t3tools/contracts";

/** "45s", "3m", "1h 5m". */
export function formatStepDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "40초", "12분", "1시간 5분": formatStepDuration in Korean units. */
export function formatKoreanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/** "950", "12k", "1.2M". */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  // Round first, so 999,600 reads "1.0M" rather than "1000k".
  if (Math.round(tokens / 1000) < 1000) return `${Math.round(tokens / 1000)}k`;
  // Pick the format from the rounded value, so 9.96M reads "10M" rather than "10.0M".
  const tenths = Math.round(tokens / 100_000) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)}M` : `${Math.round(tokens / 1_000_000)}M`;
}

/** "$1.40", "<$0.01". */
export function formatCostUsd(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/** The usage parts of a step chip: time, runs, tokens in/out and cost, skipping unknowns. */
export function stepUsageParts(usage: ProjectTaskStepUsage | undefined): ReadonlyArray<string> {
  if (usage === undefined || usage.runs === 0) return [];
  const parts = [
    usage.runs > 1
      ? `${formatStepDuration(usage.durationMs)} ×${usage.runs}`
      : formatStepDuration(usage.durationMs),
  ];
  if (usage.inputTokens + usage.outputTokens > 0) {
    parts.push(`${formatTokenCount(usage.inputTokens)}/${formatTokenCount(usage.outputTokens)}`);
  }
  if (usage.costUsd !== null) parts.push(formatCostUsd(usage.costUsd));
  return parts;
}

export const TASK_SIZE_LABELS: Record<ProjectTaskSize, string> = {
  small: "소",
  medium: "중",
  large: "대",
};

/**
 * The task's total line, such as "합계 27m · 2.1M/68k 토큰 · 약 $4.90 · 리뷰 지적 3 · 수정 1회 ·
 * CI 실패 0 · 메모리로 멈춘 시간 12분", the last part only when memory held it. Null before
 * any step has finished.
 */
export function taskUsageTotal(
  usage: ProjectTaskStepUsages,
  metrics: ProjectTaskMetrics,
): string | null {
  let durationMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let runs = 0;
  for (const role of PROJECT_TASK_MODEL_ROLES) {
    const step = usage[role];
    if (step === undefined) continue;
    durationMs += step.durationMs;
    inputTokens += step.inputTokens;
    outputTokens += step.outputTokens;
    runs += step.runs;
    if (step.costUsd !== null) costUsd = (costUsd ?? 0) + step.costUsd;
  }
  if (runs === 0) return null;
  const parts = [`합계 ${formatStepDuration(durationMs)}`];
  if (inputTokens + outputTokens > 0) {
    parts.push(`${formatTokenCount(inputTokens)}/${formatTokenCount(outputTokens)} 토큰`);
  }
  if (costUsd !== null) parts.push(`약 ${formatCostUsd(costUsd)}`);
  parts.push(
    `리뷰 지적 ${metrics.reviewFindings}`,
    `수정 ${metrics.fixRounds}회`,
    `CI 실패 ${metrics.ciFailures}`,
  );
  // Under half a second reads "0초": not worth a part.
  if (Math.round(metrics.memoryStallMs / 1000) > 0) {
    parts.push(`메모리로 멈춘 시간 ${formatKoreanDuration(metrics.memoryStallMs)}`);
  }
  if (metrics.size !== null) parts.push(`크기 ${TASK_SIZE_LABELS[metrics.size]}`);
  return parts.join(" · ");
}
