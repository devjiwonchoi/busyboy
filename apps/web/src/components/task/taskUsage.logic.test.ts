import { describe, expect, it } from "vite-plus/test";

import { formatCostUsd, formatStepDuration, formatTokenCount } from "./taskUsage.logic";

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
});
