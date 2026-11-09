import { describe, expect, it } from "vite-plus/test";
import { buildGoalGraph, layoutGoalGraph, relatedNodeIds } from "./goalGraph.logic";
import { GRAPH_NOW, goalGraphFixture, graphTask } from "./goalGraph.test-fixtures";

const build = () => buildGoalGraph({ entries: goalGraphFixture(), nowMs: GRAPH_NOW });
describe("goal graph", () => {
  it("aligns goals, descendants, proposals, recent completions and unaligned work", () => {
    const graph = build();
    expect(graph.goals.map((goal) => goal.id)).toEqual(["goal-1", "goal-2", "goal-3", "goal:none"]);
    expect(graph.goals[0]).toMatchObject({
      done: 2,
      total: 5,
      blocked: true,
      proposals: [{ item: { taskId: "proposal" } }],
    });
    expect(graph.goals[2]?.missingWork).toBe(true);
    expect(graph.projects.map((project) => project.projectId)).toEqual(["a", "b"]);
    expect(graph.tasks.map((task) => task.id)).toEqual([
      "a-1",
      "a-2",
      "a-3",
      "a-4",
      "b-1",
      "b-2",
      "b-3",
    ]);
    expect(graph.tasks.find((task) => task.id === "b-3")).toMatchObject({
      goalIds: ["goal:none"],
      depth: 1,
    });
    expect(graph.tasks.find((task) => task.id === "a-3")).toMatchObject({
      tone: "review",
      depth: 1,
    });
    expect(graph.tasks.find((task) => task.id === "a-4")?.tone).toBe("done");
    expect(graph.tasks.find((task) => task.id === "a-1")).toMatchObject({
      tone: "blocked",
      needsYou: true,
      blockReasons: ["waiting_on_user"],
    });
    expect(graph.tasks.find((task) => task.id === "b-1")).toMatchObject({
      tone: "blocked",
      waitsOnKeys: ["A-2"],
      blockReasons: ["waits_on"],
    });
    expect(graph.briefing).toMatchObject({
      blockedCount: 2,
      needsYouCount: 1,
      firstBlockedNodeId: "task:env-1/a-1",
      firstNeedsYouNodeId: "task:env-1/a-1",
    });
  });
  it("connects goals, projects, parents and cross-project waits with blocked edges", () => {
    const graph = build();
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "goal-1",
          to: "project:env-1/a",
          kind: "goal-project",
          blocked: true,
        }),
        expect.objectContaining({
          from: "project:env-1/b",
          to: "task:env-1/b-1",
          kind: "project-task",
          blocked: true,
        }),
        expect.objectContaining({ from: "task:env-1/a-1", to: "task:env-1/a-3", kind: "parent" }),
        expect.objectContaining({
          from: "task:env-1/b-1",
          to: "task:env-1/a-2",
          kind: "waits",
          blocked: true,
        }),
        expect.objectContaining({ from: "goal:none", to: "project:env-1/b" }),
      ]),
    );
    const related = relatedNodeIds(graph, "task:env-1/b-1");
    expect(related.has("task:env-1/a-2")).toBe(true);
    expect(related.has("goal-2")).toBe(true);
    expect(related.has("goal-3")).toBe(false);
    // Project a serves goal-1 only through a-1..a-4; hovering goal-2's task keeps a-1 dark.
    expect(related.has("task:env-1/a-1")).toBe(false);
    const fromGoal = relatedNodeIds(graph, "goal:none");
    expect(fromGoal.has("task:env-1/b-2")).toBe(true);
    expect(fromGoal.has("task:env-1/b-1")).toBe(false);
    expect(fromGoal.has("goal-2")).toBe(false);
  });
  it("lays out each column without overlaps and curves every edge", () => {
    const graph = build();
    const layout = layoutGoalGraph(graph);
    for (const column of [0, 320, 640]) {
      const boxes = layout.boxes
        .filter((box) => (column === 640 ? box.x >= 640 : box.x === column))
        .toSorted((a, b) => a.y - b.y);
      boxes
        .slice(1)
        .forEach((box, index) =>
          expect(box.y).toBeGreaterThanOrEqual(boxes[index]!.y + boxes[index]!.height + 12),
        );
    }
    expect(layout.paths.length).toBe(graph.edges.length);
    expect(layout.paths.every((edge) => /^M.* C/.test(edge.d))).toBe(true);
  });
  it("handles fatal blockers, finished dependencies and proposal ancestry", () => {
    const entries = goalGraphFixture();
    entries[0]!.summary = {
      ...entries[0]!.summary,
      tasks: [
        ...entries[0]!.summary.tasks,
        graphTask("fatal", 7, { openBlocker: true, openQuestion: true }),
        graphTask("finished-wait", 8, { waitsOn: ["a-4" as never] }),
      ],
    };
    const graph = buildGoalGraph({ entries, nowMs: GRAPH_NOW });
    expect(graph.tasks.find((task) => task.id === "fatal")?.blockReasons).toEqual(["fatal"]);
    expect(graph.tasks.find((task) => task.id === "finished-wait")?.tone).toBe("running");
  });
  it("keeps environments separate even when task and project ids repeat", () => {
    const entries = goalGraphFixture();
    const copy = { ...entries[0]!, environmentId: "env-2" as never };
    const graph = buildGoalGraph({ entries: [...entries, copy], nowMs: GRAPH_NOW });
    expect(graph.tasks.find((task) => task.nodeId === "task:env-2/a-1")?.goalIds).toEqual([
      "goal:none",
    ]);
  });
});
