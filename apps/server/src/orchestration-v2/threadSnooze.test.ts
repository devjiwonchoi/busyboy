import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSnoozed } from "./threadSnooze.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

describe("isSnoozed", () => {
  const snoozed = {
    snoozedAt: at(-2 * DAY_MS),
    snoozedUntil: at(DAY_MS),
    latestRunCompletedAt: null,
    status: "idle",
    pendingRuntimeRequest: null,
  } as const;
  it("wakes for completed work after the snooze, but not an interrupted run", () => {
    expect(isSnoozed(snoozed, NOW_MS)).toBe(true);
    expect(
      isSnoozed({ ...snoozed, status: "interrupted", latestRunCompletedAt: at(-DAY_MS) }, NOW_MS),
    ).toBe(true);
    expect(
      isSnoozed({ ...snoozed, status: "completed", latestRunCompletedAt: at(-DAY_MS) }, NOW_MS),
    ).toBe(false);
    expect(isSnoozed({ ...snoozed, snoozedUntil: at(-1) }, NOW_MS)).toBe(false);
  });
});
