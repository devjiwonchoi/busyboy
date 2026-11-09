import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ComposerProjectCandidate,
  matchComposerProjectItems,
} from "./composerProjectItems.ts";

const env = EnvironmentId.make("env-1");
const otherEnv = EnvironmentId.make("env-2");
const project = (
  id: string,
  title: string,
  overrides: Partial<ComposerProjectCandidate> = {},
): ComposerProjectCandidate => ({
  environmentId: env,
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/code/${title}`,
  ...overrides,
});

const titles = (query: string, projects: ReadonlyArray<ComposerProjectCandidate>) =>
  matchComposerProjectItems({ projects, environmentId: env, query }).map((item) => item.label);

describe("matchComposerProjectItems", () => {
  const projects = [
    project("p1", "next-bot"),
    project("p2", "next-benchmarks"),
    project("p3", "busyboy"),
    project("p4", "next-maintainer-agent"),
  ];

  it("lists every project for a bare @, sorted by name", () => {
    expect(titles("", projects)).toEqual([
      "busyboy",
      "next-benchmarks",
      "next-bot",
      "next-maintainer-agent",
    ]);
  });

  it("filters by name and ranks prefix matches first", () => {
    expect(titles("next-b", projects)).toEqual(["next-benchmarks", "next-bot"]);
    expect(titles("BOY", projects)).toEqual(["busyboy"]);
  });

  it("ranks a name starting with the query ahead of one containing it", () => {
    expect(titles("bot", [project("a", "next-bot"), project("b", "bot-runner")])).toEqual([
      "bot-runner",
      "next-bot",
    ]);
  });

  it("skips other environments and scratch projects", () => {
    expect(
      titles("", [
        project("p1", "next-bot"),
        project("p2", "remote", { environmentId: otherEnv }),
        project("p3", "scratch", { isScratch: true }),
      ]),
    ).toEqual(["next-bot"]);
  });

  it("carries the project identity and shows the path as description", () => {
    expect(matchComposerProjectItems({ projects, environmentId: env, query: "busy" })).toEqual([
      {
        id: "project:env-1:p3",
        type: "project",
        project: {
          environmentId: env,
          projectId: ProjectId.make("p3"),
          title: "busyboy",
          workspaceRoot: "/code/busyboy",
        },
        label: "busyboy",
        description: "/code/busyboy",
      },
    ]);
  });

  it("caps the list at eight projects", () => {
    const many = Array.from({ length: 12 }, (_, index) => project(`p${index}`, `proj-${index}`));
    expect(titles("", many)).toHaveLength(8);
  });
});
