import { describe, expect, it } from "vite-plus/test";
import { buildGoalGraph, changedLabel, layoutGoalGraph, relatedNodeIds } from "./goalGraph.logic";
import {
  GRAPH_NOW,
  goalGraphFixture,
  goalGraphSignalsFixture,
  graphCard,
  graphTask,
} from "./goalGraph.test-fixtures";

const build = () => buildGoalGraph({ entries: goalGraphFixture(), nowMs: GRAPH_NOW });
describe("goal graph", () => {
  it("aligns goals, descendants, recent completions and unaligned work", () => {
    const graph = build();
    expect(graph.goals.map((goal) => goal.id)).toEqual(["goal-1", "goal-2", "goal-3", "goal:none"]);
    expect(graph.goals[0]).toMatchObject({
      done: 2,
      total: 5,
      blocked: true,
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
  it("handles fatal blockers and finished dependencies", () => {
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

describe("live graph signals", () => {
  it("rolls up pulse, card counts and newest changes across projects", () => {
    const entries = goalGraphSignalsFixture();
    entries[0]!.summary = {
      ...entries[0]!.summary,
      decisionCards: [
        ...entries[0]!.summary.decisionCards,
        {
          ...graphCard("a-1"),
          item: { ...graphCard("a-1").item, id: "second-card" as never },
        },
      ],
    };
    const graph = buildGoalGraph({ entries, nowMs: GRAPH_NOW });
    expect(graph.tasks.find((task) => task.id === "a-1")).toMatchObject({
      live: true,
      waitingCount: 2,
      changedLabel: "3시간 전",
    });
    for (const project of graph.projects) {
      expect(project.needsYou).toBe(
        graph.tasks
          .filter((task) => task.projectKey === project.key)
          .reduce((sum, task) => sum + task.waitingCount, 0),
      );
    }
    expect(graph.projects[0]).toMatchObject({
      live: true,
      needsYou: 2,
      recent: true,
      changedLabel: "3시간 전",
    });
    expect(graph.goals[0]).toMatchObject({
      live: true,
      needsYou: 3,
      recent: true,
      changedLabel: "3시간 전",
      waitingTarget: { cardId: "card-a-1" },
    });
    expect(graph.directorBriefing).toBe("목표 2는 결정 1건에 막혀 있어요");
    entries[1]!.summary = {
      ...entries[1]!.summary,
      presence: { ...entries[1]!.summary.presence, running: 1 },
      tasks: entries[1]!.summary.tasks.map((task) => ({
        ...task,
        stage: "planning",
        openQuestion: true,
      })),
      decisionCards: [],
    };
    const fallback = buildGoalGraph({ entries, nowMs: GRAPH_NOW });
    expect(fallback.tasks.find((task) => task.id === "b-1")?.waitingCount).toBe(1);
    expect(fallback.projects[1]?.live).toBe(true);
    expect(fallback.goals.find((goal) => goal.id === "goal-2")?.live).toBe(false);
  });
  it("does not pulse running tasks that are waiting or stalled", () => {
    const entries = goalGraphSignalsFixture();
    entries[0]!.summary = {
      ...entries[0]!.summary,
      tasks: [
        graphTask("question", 10, { openQuestion: true }),
        graphTask("blocker", 11, { openBlocker: true }),
        graphTask("stalled", 12, { lastOutcome: "stalled" }),
      ],
    };
    const graph = buildGoalGraph({ entries, nowMs: GRAPH_NOW });
    expect(graph.tasks.filter((task) => task.projectId === "a").map((task) => task.live)).toEqual([
      false,
      false,
      false,
    ]);
    expect(graph.projects[0]?.live).toBe(false);
  });
  it("rolls up only visible work when an old waiting lead shares a goal", () => {
    const entries = goalGraphSignalsFixture();
    entries[0]!.summary = {
      ...entries[0]!.summary,
      tasks: entries[0]!.summary.tasks.map((task) => ({ ...task, stage: "planning" })),
      decisionCards: [],
      presence: { ...entries[0]!.summary.presence, running: 1 },
    };
    const graph = buildGoalGraph({ entries, nowMs: GRAPH_NOW, recentOnly: true });
    expect(graph.goals[0]).toMatchObject({
      needsYou: 0,
      live: false,
      changedLabel: "3시간 전",
      waitingTarget: null,
    });
    expect(graph.projects[0]).toMatchObject({ needsYou: 0, live: false, waitingTarget: null });
    expect(graph.briefing).toMatchObject({ needsYouCount: 0, firstNeedsYouNodeId: null });
    expect(graph.goals.map((goal) => goal.id)).toEqual(["goal-1"]);
  });
  it("labels the five-minute, hour and day boundaries", () => {
    const label = (minutes: number) =>
      changedLabel(new Date(GRAPH_NOW - minutes * 60000).toISOString(), GRAPH_NOW);
    expect(label(0)).toBe("방금 바뀜");
    expect(label(4.99)).toBe("방금 바뀜");
    expect(label(5)).toBe("5분 전");
    expect(label(59)).toBe("59분 전");
    expect(label(60)).toBe("1시간 전");
    expect(label(1439)).toBe("23시간 전");
    expect(label(1440)).toBeNull();
    expect(label(2880)).toBeNull();
    expect(changedLabel(null, GRAPH_NOW)).toBeNull();
  });
  it("keeps only recent tasks, their ancestors and valid edges", () => {
    const filtered = buildGoalGraph({
      entries: goalGraphSignalsFixture(),
      nowMs: GRAPH_NOW,
      recentOnly: true,
    });
    expect(filtered.tasks.map((task) => task.id)).toEqual(["a-1"]);
    expect(filtered.projects.map((project) => project.projectId)).toEqual(["a"]);
    expect(filtered.goals.map((goal) => goal.id)).toEqual(["goal-1"]);
    expect(layoutGoalGraph(filtered).paths).toHaveLength(2);
    expect(filtered.briefing).toMatchObject({ needsYouCount: 1, blockedCount: 1 });
    expect(filtered.goals[0]).toMatchObject({ needsYou: 1, waitingTarget: { id: "a-1" } });
    expect(filtered.projects[0]).toMatchObject({ needsYou: 1, waitingTarget: { id: "a-1" } });
    const empty = buildGoalGraph({
      entries: goalGraphSignalsFixture(),
      nowMs: GRAPH_NOW + 86400000,
      recentOnly: true,
    });
    expect(empty.tasks).toHaveLength(0);
    expect(empty.goals).toHaveLength(0);
    expect(layoutGoalGraph(empty).paths).toHaveLength(0);
  });
});

describe("goal graph panel summaries", () => {
  it("keeps global attention chronological and independent of goals and recent filtering", () => {
    const entries = goalGraphFixture();
    const firstBase = graphCard("old");
    const first = {
      ...firstBase,
      item: { ...firstBase.item, createdAt: "2026-11-01T00:00:00.000Z" },
    };
    const lastBase = graphCard("new");
    const last = { ...lastBase, item: { ...lastBase.item, createdAt: "2026-11-03T00:00:00.000Z" } };
    const middleBase = graphCard("middle");
    const middle = {
      ...middleBase,
      item: { ...middleBase.item, createdAt: "2026-11-02T00:00:00.000Z" },
    };
    const answeredBase = graphCard("answered");
    const answered = {
      ...answeredBase,
      item: { ...answeredBase.item, answeredAt: "2026-11-04T00:00:00.000Z" },
    };
    const withdrawnBase = graphCard("withdrawn");
    const withdrawn = {
      ...withdrawnBase,
      item: { ...withdrawnBase.item, supersededAt: "2026-11-04T00:00:00.000Z" },
    };
    entries[0]!.summary = {
      ...entries[0]!.summary,
      decisionCards: [last, withdrawn, first, answered],
    };
    entries[1]!.summary = { ...entries[1]!.summary, decisionCards: [middle] };
    entries[2]!.summary = { ...entries[2]!.summary, goals: [], decisionCards: [] };
    const graph = buildGoalGraph({ entries, nowMs: GRAPH_NOW, recentOnly: true });
    expect(graph.attention.cards.map(({ card }) => card.item.taskId)).toEqual([
      "old",
      "middle",
      "new",
    ]);
    expect(graph.attention.total).toBe(3);
  });
  it("summarizes stalled and review work and excludes finished waits and cancelled children", () => {
    const entries = goalGraphFixture();
    entries[2]!.summary = {
      ...entries[2]!.summary,
      tasks: [
        graphTask("epic", 10, {
          stage: "running",
          waitsOn: ["a-4" as never, "a-cancelled" as never, "a-2" as never],
        }),
      ],
    };
    entries[0]!.summary = {
      ...entries[0]!.summary,
      tasks: entries[0]!.summary.tasks.map((task) => ({
        ...task,
        parentTaskId: "epic" as never,
        lastOutcome: task.id === "a-2" || task.stage === "done" ? "stalled" : null,
      })),
    };
    const graph = buildGoalGraph({ entries, nowMs: GRAPH_NOW });
    const epic = graph.epics[0]!;
    expect(epic.progress).toEqual({ done: 2, total: 5 });
    expect(epic.cancelled).toBe(1);
    expect(epic.blockedBy.map((task) => task.key)).toEqual(["A-2"]);
    expect(
      graph.runningProjects[0]!.tasks.map((task) => [task.id, task.stalled, task.live]),
    ).toEqual([
      ["a-1", false, true],
      ["a-2", true, false],
      ["a-3", false, false],
    ]);
    expect(epic.counts.reduce((sum, [, count]) => sum + count, 0)).toBe(5);
  });
});
