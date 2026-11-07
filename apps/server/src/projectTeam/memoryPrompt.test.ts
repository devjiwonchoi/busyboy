import { describe, expect, it } from "@effect/vitest";

import { memoryOverBudgetNote, memoryPromptSection } from "./memoryPrompt.ts";

const entry = (topic: string, content: string, updatedAt: string) => ({
  topic,
  content,
  updatedAt,
});

describe("memoryPromptSection", () => {
  it("includes small memory whole, core topics first", () => {
    const section = memoryPromptSection([
      entry("testing", "Run changed tests only.", "2026-11-06T00:00:00.000Z"),
      entry("preferences", "Reply in Korean.", "2026-11-01T00:00:00.000Z"),
    ]);
    expect(section).toBe(
      "### preferences\nReply in Korean.\n\n### testing\nRun changed tests only.",
    );
  });

  it("keeps core topics whole and indexes the rest once memory is over budget", () => {
    const section = memoryPromptSection(
      [
        entry("sidebar", `- Rows are flat.\n${"s".repeat(80)}`, "2026-11-05T09:00:00.000Z"),
        entry("decisions", "2026-11-05 Squash-merge only.", "2026-11-05T00:00:00.000Z"),
        entry("decisions-layout", "d".repeat(60), "2026-11-02T00:00:00.000Z"),
        entry("preferences", "Reply in Korean.", "2026-11-06T00:00:00.000Z"),
      ],
      100,
    );
    expect(section).toBe(
      [
        "### preferences\nReply in Korean.",
        "### decisions\n2026-11-05 Squash-merge only.",
        [
          "### Other topics (read them with memory_list)",
          "- sidebar (2026-11-05): Rows are flat.",
          `- decisions-layout (2026-11-02): ${"d".repeat(60)}`,
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  it("says so when there is no memory", () => {
    expect(memoryPromptSection([])).toBe("No project memory yet.");
  });
});

describe("memoryOverBudgetNote", () => {
  it("is quiet while memory fits", () => {
    expect(memoryOverBudgetNote([entry("a", "short", "2026-11-01T00:00:00.000Z")], 100)).toBe(null);
  });

  it("names the size and the oldest topics when memory is over budget", () => {
    expect(
      memoryOverBudgetNote(
        [
          entry("new", "n".repeat(60), "2026-11-06T00:00:00.000Z"),
          entry("old", "o".repeat(60), "2026-10-01T00:00:00.000Z"),
        ],
        100,
      ),
    ).toBe(
      "Memory is over budget (126 of 100 chars): merge overlapping topics and delete superseded or finished-task detail. Oldest: old (2026-10-01), new (2026-11-06).",
    );
  });
});
