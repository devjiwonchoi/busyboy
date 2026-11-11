import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PROJECT_TASK_METRICS } from "@t3tools/contracts";

import {
  formatCostUsd,
  formatKoreanDuration,
  formatStepDuration,
  formatTokenCount,
  taskUsageTotal,
} from "./taskUsage.logic";

describe("task usage formatting", () => {
  it("rounds tokens to k and M without showing 1000k", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_400)).toBe("12k");
    expect(formatTokenCount(999_400)).toBe("999k");
    expect(formatTokenCount(999_600)).toBe("1.0M");
    expect(formatTokenCount(1_240_000)).toBe("1.2M");
    expect(formatTokenCount(9_940_000)).toBe("9.9M");
    expect(formatTokenCount(9_960_000)).toBe("10M");
    expect(formatTokenCount(12_600_000)).toBe("13M");
  });

  it("formats durations and costs", () => {
    expect(formatStepDuration(45_000)).toBe("45s");
    expect(formatStepDuration(3 * 60_000)).toBe("3m");
    expect(formatStepDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatCostUsd(1.4)).toBe("$1.40");
    expect(formatCostUsd(0.004)).toBe("<$0.01");
  });

  it("formats memory stall time in Korean units", () => {
    expect(formatKoreanDuration(40_000)).toBe("40초");
    expect(formatKoreanDuration(12 * 60_000)).toBe("12분");
    expect(formatKoreanDuration(65 * 60_000)).toBe("1시간 5분");
    expect(formatKoreanDuration(2 * 60 * 60_000)).toBe("2시간");
  });

  it("adds memory stall time to the total only when memory held the task", () => {
    const usage = {
      plan: {
        runs: 1,
        durationMs: 3 * 60_000,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      },
    };
    expect(taskUsageTotal(usage, EMPTY_PROJECT_TASK_METRICS)).toBe(
      "합계 3m · 리뷰 지적 0 · 수정 0회 · CI 실패 0",
    );
    expect(
      taskUsageTotal(usage, { ...EMPTY_PROJECT_TASK_METRICS, memoryStallMs: 12 * 60_000 }),
    ).toBe("합계 3m · 리뷰 지적 0 · 수정 0회 · CI 실패 0 · 메모리로 멈춘 시간 12분");
    expect(taskUsageTotal(usage, { ...EMPTY_PROJECT_TASK_METRICS, memoryStallMs: 400 })).toBe(
      "합계 3m · 리뷰 지적 0 · 수정 0회 · CI 실패 0",
    );
  });
});
