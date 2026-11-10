import { describe, expect, it } from "@effect/vitest";

import { parseDarwinMemoryPressure, parseDarwinSwapUsage } from "./HostResources.ts";
import { judgeHeadroom } from "./MemoryHeadroom.ts";

const GIB = 1024 ** 3;
const settings = { startMinFreeBytes: 1.5 * GIB, pauseBelowFreeBytes: 0.75 * GIB };

describe("macOS memory readings", () => {
  it("reads the memory pressure level", () => {
    expect(parseDarwinMemoryPressure("1\n")).toBe("normal");
    expect(parseDarwinMemoryPressure("2")).toBe("warn");
    expect(parseDarwinMemoryPressure("4\n")).toBe("critical");
    expect(parseDarwinMemoryPressure("")).toBeNull();
  });

  it("reads swap usage", () => {
    expect(
      parseDarwinSwapUsage(
        "vm.swapusage: total = 2048.00M  used = 698.00M  free = 1350.00M  (encrypted)\n",
      ),
    ).toEqual({ totalBytes: 2048 * 1024 ** 2, usedBytes: 698 * 1024 ** 2 });
    expect(parseDarwinSwapUsage("vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M")).toEqual(
      { totalBytes: 0, usedBytes: 0 },
    );
    expect(parseDarwinSwapUsage("")).toBeNull();
  });
});

describe("judgeHeadroom", () => {
  it("is ok with enough free memory, normal pressure and free swap", () => {
    expect(judgeHeadroom({ availableMemoryBytes: 2 * GIB }, settings)).toBe("ok");
    expect(
      judgeHeadroom(
        {
          availableMemoryBytes: 2 * GIB,
          memoryPressure: "normal",
          swapTotalBytes: 2 * GIB,
          swapUsedBytes: GIB,
        },
        settings,
      ),
    ).toBe("ok");
  });

  it("is tight between the thresholds, under warn pressure or with little swap left", () => {
    expect(judgeHeadroom({ availableMemoryBytes: GIB }, settings)).toBe("tight");
    expect(judgeHeadroom({ availableMemoryBytes: 2 * GIB, memoryPressure: "warn" }, settings)).toBe(
      "tight",
    );
    expect(
      judgeHeadroom(
        { availableMemoryBytes: 2 * GIB, swapTotalBytes: 100, swapUsedBytes: 90 },
        settings,
      ),
    ).toBe("tight");
  });

  it("is critical below the pause threshold, under critical pressure or with swap almost full", () => {
    expect(judgeHeadroom({ availableMemoryBytes: 0.5 * GIB }, settings)).toBe("critical");
    expect(
      judgeHeadroom({ availableMemoryBytes: 4 * GIB, memoryPressure: "critical" }, settings),
    ).toBe("critical");
    expect(
      judgeHeadroom(
        { availableMemoryBytes: 4 * GIB, swapTotalBytes: 100, swapUsedBytes: 97 },
        settings,
      ),
    ).toBe("critical");
  });
});
