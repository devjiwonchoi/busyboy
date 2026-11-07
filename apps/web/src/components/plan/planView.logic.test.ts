import type { ProjectTaskFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planBreakdownMermaid,
  planFileTree,
  planProgressLabel,
  planTodoDependencyNumbers,
  planTodoStatuses,
  type PlanTodoLike,
} from "./planView.logic";

const todo = (id: string, done = false, dependsOn: string[] = []): PlanTodoLike => ({
  id,
  text: `Step ${id}`,
  done,
  doneWhen: "",
  dependsOn,
});

describe("planTodoStatuses", () => {
  it("marks nothing current before the work starts", () => {
    expect(planTodoStatuses([todo("a", true), todo("b")], false)).toEqual(["done", "todo"]);
  });

  it("makes the first ready open todo current while running", () => {
    const todos = [todo("a", true), todo("b", false, ["c"]), todo("c"), todo("d")];
    expect(planTodoStatuses(todos, true)).toEqual(["done", "todo", "current", "todo"]);
  });

  it("ignores dependencies on todos that no longer exist", () => {
    expect(planTodoStatuses([todo("a", false, ["gone"])], true)).toEqual(["current"]);
  });
});

describe("planTodoDependencyNumbers", () => {
  it("returns sorted step numbers of known dependencies", () => {
    const todos = [todo("a"), todo("b"), todo("c", false, ["b", "a", "x"])];
    expect(planTodoDependencyNumbers(todos, todos[2]!)).toEqual([1, 2]);
  });
});

describe("planProgressLabel", () => {
  it("counts steps and done ones", () => {
    expect(planProgressLabel([todo("a", true), todo("b")])).toBe("2 steps · 1 done");
    expect(planProgressLabel([todo("a")])).toBe("1 step · 0 done");
  });
});

describe("planBreakdownMermaid", () => {
  it("draws steps, edges and status classes", () => {
    const todos = [todo("a", true), { ...todo("b", false, ["a"]), text: 'Card "big" [x]' }];
    const graph = planBreakdownMermaid(todos, planTodoStatuses(todos, true));
    expect(graph).toBe(
      [
        "flowchart LR",
        '  s1["1. Step a"]',
        '  s2["2. Card big x"]',
        "  s1 --> s2",
        "  classDef done fill:#16a34a22,stroke:#16a34a;",
        "  classDef current fill:#3b82f622,stroke:#3b82f6;",
        "  class s1 done;",
        "  class s2 current;",
      ].join("\n"),
    );
  });

  it("is null without dependencies", () => {
    const todos = [todo("a"), todo("b")];
    expect(planBreakdownMermaid(todos, planTodoStatuses(todos, false))).toBeNull();
  });
});

describe("planFileTree", () => {
  const file = (path: string): ProjectTaskFile => ({ path, change: "changed", why: "", todos: [] });

  it("groups by folder, folders first, and merges single-child folders", () => {
    const tree = planFileTree([
      file("apps/web/src/b.ts"),
      file("apps/web/src/plan/a.ts"),
      file("README.md"),
    ]);
    expect(tree.map((node) => [node.kind, node.name])).toEqual([
      ["folder", "apps/web/src"],
      ["file", "README.md"],
    ]);
    const src = tree[0]!;
    expect(src.path).toBe("apps/web/src");
    expect(src.children.map((node) => [node.kind, node.name, node.path])).toEqual([
      ["folder", "plan", "apps/web/src/plan"],
      ["file", "b.ts", "apps/web/src/b.ts"],
    ]);
  });
});
