import { describe, expect, it } from "@effect/vitest";

import { allocateTaskKeyPrefixes } from "./taskKeyPrefixes.ts";

describe("allocateTaskKeyPrefixes", () => {
  it("resolves legacy collisions by project name and preserves the old key as an alias", () => {
    const assigned = allocateTaskKeyPrefixes({
      projects: [
        { projectId: "bot", title: "next-bot", prefix: "NB", aliases: [] },
        { projectId: "bench", title: "next-benchmarks", prefix: "NB", aliases: [] },
      ],
    });
    expect(assigned).toEqual([
      { projectId: "bench", prefix: "NB", aliases: [] },
      { projectId: "bot", prefix: "NB2", aliases: ["NB"] },
    ]);
  });

  it("reserves saved suffixes and caps the resulting prefix at six characters", () => {
    const assigned = allocateTaskKeyPrefixes({
      projects: [
        { projectId: "one", title: "First", prefix: "ABCDEF", aliases: [] },
        { projectId: "two", title: "Second", prefix: "ABCDEF", aliases: [] },
        { projectId: "three", title: "Third", prefix: "ABCDE2", aliases: [] },
      ],
    });
    expect(assigned.map((project) => project.prefix)).toEqual(["ABCDEF", "ABCDE3", "ABCDE2"]);
  });

  it("preserves saved prefixes after a rename and a repeated reconciliation", () => {
    const assigned = allocateTaskKeyPrefixes({
      projects: [
        { projectId: "old", title: "Renamed", prefix: "NB", aliases: ["OLD"] },
        { projectId: "new", title: "next-bot", prefix: undefined, aliases: [] },
      ],
    });
    expect(assigned.find((project) => project.projectId === "old")).toEqual({
      projectId: "old",
      prefix: "NB",
      aliases: ["OLD"],
    });
    expect(assigned.find((project) => project.projectId === "new")?.prefix).toBe("NB2");
    expect(
      allocateTaskKeyPrefixes({
        projects: assigned.map((project) => ({
          ...project,
          title: project.projectId,
        })),
      })
        .map((project) => [project.projectId, project.prefix])
        .toSorted(),
    ).toEqual(assigned.map((project) => [project.projectId, project.prefix]).toSorted());
  });
});
