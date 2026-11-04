import type { BrowserHistoryVisit } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { clearsSomeDataForAllTime, groupVisitsByDay } from "./BrowserHistorySettings.logic";

function visitAt(id: number, date: Date): BrowserHistoryVisit {
  return {
    id,
    url: `https://site.test/${id}`,
    title: null,
    visitedAt: date.getTime(),
    transition: "link",
    source: "user",
    threadId: null,
  };
}

describe("groupVisitsByDay", () => {
  it("groups newest-first visits by local day with Today and Yesterday labels", () => {
    const now = new Date(2026, 10, 4, 15, 0);
    const groups = groupVisitsByDay(
      [
        visitAt(1, new Date(2026, 10, 4, 14, 0)),
        visitAt(2, new Date(2026, 10, 4, 0, 5)),
        visitAt(3, new Date(2026, 10, 3, 23, 55)),
        visitAt(4, new Date(2026, 9, 30, 12, 0)),
      ],
      now.getTime(),
    );
    expect(groups.map((group) => [group.key, group.visits.map((visit) => visit.id)])).toEqual([
      ["2026-11-04", [1, 2]],
      ["2026-11-03", [3]],
      ["2026-10-30", [4]],
    ]);
    expect(groups[0]?.label).toBe("Today");
    expect(groups[1]?.label).toBe("Yesterday");
    expect(groups[2]?.label).not.toMatch(/Today|Yesterday|2026/);
  });
});

describe("clearsSomeDataForAllTime", () => {
  it("flags cookies or cache cleared for a partial range", () => {
    expect(clearsSomeDataForAllTime("hour", ["history"])).toBe(false);
    expect(clearsSomeDataForAllTime("hour", ["history", "cache"])).toBe(true);
    expect(clearsSomeDataForAllTime("all", ["cookies_site_data"])).toBe(false);
  });
});
