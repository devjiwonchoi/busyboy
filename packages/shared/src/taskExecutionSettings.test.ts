import { describe, expect, it } from "vite-plus/test";

import {
  bytesToGb,
  formatTaskExecutionMemoryStatus,
  gbToBytes,
  planTaskExecutionMemoryPatch,
} from "./taskExecutionSettings.ts";

const GIB = 1024 * 1024 * 1024;

describe("formatTaskExecutionMemoryStatus", () => {
  it("shows free memory, swap and pressure", () => {
    expect(
      formatTaskExecutionMemoryStatus({
        availableMemoryBytes: 2.1 * GIB,
        swapUsedBytes: 0.7 * GIB,
        swapTotalBytes: 2 * GIB,
        memoryPressure: "normal",
      }),
    ).toBe("지금: 여유 2.1 GB · 스왑 0.7 / 2 GB · 보통");
  });

  it("drops swap and pressure when the host does not report them", () => {
    expect(formatTaskExecutionMemoryStatus({ availableMemoryBytes: 3 * GIB })).toBe(
      "지금: 여유 3 GB",
    );
    expect(
      formatTaskExecutionMemoryStatus({
        availableMemoryBytes: 0.4 * GIB,
        memoryPressure: "critical",
      }),
    ).toBe("지금: 여유 0.4 GB · 위험");
    expect(
      formatTaskExecutionMemoryStatus({ availableMemoryBytes: GIB, memoryPressure: "warn" }),
    ).toBe("지금: 여유 1 GB · 빠듯");
  });
});

describe("planTaskExecutionMemoryPatch", () => {
  it("writes both thresholds in bytes", () => {
    expect(planTaskExecutionMemoryPatch({ startMinFreeGb: 1.5, pauseBelowFreeGb: 0.75 })).toEqual({
      ok: true,
      patch: { taskExecution: { startMinFreeBytes: 1.5 * GIB, pauseBelowFreeBytes: 0.75 * GIB } },
    });
  });

  it("rejects a pause threshold at or above the start threshold", () => {
    expect(planTaskExecutionMemoryPatch({ startMinFreeGb: 1, pauseBelowFreeGb: 1 })).toEqual({
      ok: false,
      message: "멈추는 기준은 시작 기준보다 작아야 해요.",
    });
  });

  it("rejects values outside what the server accepts", () => {
    expect(planTaskExecutionMemoryPatch({ startMinFreeGb: 100, pauseBelowFreeGb: 1 }).ok).toBe(
      false,
    );
    expect(planTaskExecutionMemoryPatch({ startMinFreeGb: 1, pauseBelowFreeGb: 0 }).ok).toBe(false);
    expect(
      planTaskExecutionMemoryPatch({ startMinFreeGb: Number.NaN, pauseBelowFreeGb: 0.5 }).ok,
    ).toBe(false);
  });
});

describe("GB conversion", () => {
  it("round-trips the default thresholds", () => {
    expect(bytesToGb(1.5 * GIB)).toBe(1.5);
    expect(gbToBytes(bytesToGb(0.75 * GIB))).toBe(0.75 * GIB);
  });
});
