import type {
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
  WorkspaceGoal,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildGoalMap,
  fitTransform,
  GOAL_MAP_LAYOUT,
  zoomToGoal,
  type GoalMap,
  type GoalMapEntry,
} from "./goalMap.js";

const task = (id: string, extra?: Partial<ProjectTaskReference>): ProjectTaskReference => ({
  id: id as never,
  number: Number(id.replace(/\D/g, "")) || 1,
  title: `task ${id}`,
  parentTaskId: null,
  waitsOn: [],
  stage: "running",
  leadThreadId: null,
  prUrl: null,
  lastOutcome: null,
  openQuestion: false,
  openBlocker: false,
  iterateRound: 0,
  shipRound: 0,
  modelSteps: {},
  updatedAt: null,
  checks: null,
  ...extra,
});
const goal = (id: string, position: number, projectIds: string[]): WorkspaceGoal => ({
  id: id as never,
  title: `goal ${id}`,
  detail: null,
  status: "active",
  position,
  links: projectIds.map((projectId) => ({ projectId: projectId as never, taskId: null })),
  createdAt: "2026-11-09T12:00:00.000Z",
  updatedAt: "2026-11-09T12:00:00.000Z",
});
// Only snapshot fields consumed by this pure module matter to these fixtures.
const entry = (
  projectId: string,
  tasks: ProjectTaskReference[],
  extra?: Partial<ProjectTeamAttentionSummary>,
  environmentId = "env",
): GoalMapEntry => ({
  environmentId: environmentId as never,
  summary: {
    projectId,
    pmThreadId: `pm-${projectId}`,
    tasks,
    taskKeyPrefix: "BU",
    decisionCards: [],
    ...extra,
  } as ProjectTeamAttentionSummary,
});
const director = (goals: WorkspaceGoal[], extra?: Partial<ProjectTeamAttentionSummary>) =>
  entry("director", [], { kind: "director", goals, ...extra });
const card = (taskId: string, kind: "approval" | "decision" | "blocker", answered = false) =>
  ({
    item: {
      taskId,
      kind,
      answeredAt: answered ? "2026-11-09T12:00:00.000Z" : null,
      supersededAt: null,
    },
  }) as unknown as ProjectTeamAttentionSummary["decisionCards"][number];

const goalA = goal("a", 0, ["a"]);
const build = (tasks: ProjectTaskReference[], extra?: Partial<ProjectTeamAttentionSummary>) =>
  buildGoalMap({ entries: [director([goalA]), entry("a", tasks, extra)] });

describe("buildGoalMap", () => {
  it("counts remaining, done, running, waiting and blocked work", () => {
    const map = build([
      task("1", { stage: "done" }),
      task("2", { stage: "done" }),
      task("3"),
      task("4", { stage: "inbox" }),
      task("5", { stage: "blocked" }),
      task("6", { openQuestion: true }),
      task("7", { lastOutcome: "failed" }),
      task("8", { stage: "cancelled" }),
    ]);
    expect(map.goals.map((item) => item.id)).toEqual(["a"]);
    expect(map.goals[0]!.counts).toEqual({
      remaining: 5,
      done: 2,
      inProgress: 1,
      waiting: 1,
      blocked: 3,
    });
    expect(map.goals[0]!.doneCount).toBe(2);
    expect(map.layout.dotPos.a).toHaveLength(2);
  });

  it("puts the user's turn first even while other work runs, with 외 N개", () => {
    const map = build([
      task("1"),
      task("2", { stage: "inbox" }),
      task("3", { openQuestion: true, title: "아주 긴 제목이 들어가는 작업 이름입니다" }),
      task("4", { openBlocker: true }),
    ]);
    const goalNode = map.goals[0]!;
    expect(goalNode.tasks.map((item) => item.key)).toEqual(["BU-3", "BU-4", "BU-1", "BU-2"]);
    expect(goalNode.nextAction).toMatchObject({ kind: "user", more: 1 });
    expect(goalNode.nextAction.task?.key).toBe("BU-3");
    expect(goalNode.nextAction.text).toBe("내 차례 · 답변 · BU-3 아주 긴 제목이 들어가는… 외 1개");
  });

  it("writes running, blocked, waiting and empty next actions", () => {
    expect(build([task("1"), task("2")]).goals[0]!.nextAction.text).toBe(
      "진행 중 · BU-1 task 1 외 1개",
    );
    expect(
      build([
        task("1", { stage: "inbox", waitsOn: ["2" as never] }),
        task("2", { stage: "blocked" }),
      ]).goals[0]!.nextAction.text,
    ).toBe("막힘 · BU-1 (기다림: BU-2)");
    expect(build([task("2", { stage: "blocked" })]).goals[0]!.nextAction.text).toBe("막힘 · BU-2");
    expect(build([task("1", { stage: "inbox" })]).goals[0]!.nextAction.text).toBe(
      "대기 · BU-1 task 1",
    );
    const done = build([task("1", { stage: "done" })]).goals[0]!.nextAction;
    expect(done).toEqual({ kind: "none", text: "남은 일 없음", task: null, more: 0 });
  });

  it("reads the user's turn from open cards, then blockers and questions", () => {
    const map = build(
      [
        task("1"),
        task("2"),
        task("3"),
        task("4", { openBlocker: true }),
        task("5", { openQuestion: true }),
        task("6"),
      ],
      {
        decisionCards: [
          card("1", "approval"),
          card("2", "decision"),
          card("3", "blocker"),
          card("6", "decision", true),
        ],
      },
    );
    const turns = Object.fromEntries(
      map.goals[0]!.tasks.map((item) => [item.key, item.userTurn?.label ?? null]),
    );
    expect(turns).toEqual({
      "BU-1": "승인",
      "BU-2": "결정",
      "BU-3": "조치",
      "BU-4": "조치",
      "BU-5": "답변",
      "BU-6": null,
    });
    expect(map.goals[0]!.tasks.find((item) => item.key === "BU-6")!.status).toBe("running");
  });

  it("does not count a snoozed card as the user's turn", () => {
    const snoozed = {
      item: {
        taskId: "1",
        kind: "decision",
        answeredAt: null,
        supersededAt: null,
        snoozedAt: "2026-11-11T00:00:00.000Z",
      },
    } as unknown as ProjectTeamAttentionSummary["decisionCards"][number];
    const map = build([task("1")], { decisionCards: [snoozed] });
    expect(map.goals[0]!.tasks[0]!.userTurn).toBeNull();
  });

  it("draws waitsOn edges only to unfinished visible tasks, across goals", () => {
    const map = buildGoalMap({
      entries: [
        director([goalA, goal("b", 1, ["b"])]),
        entry("a", [
          task("1", { waitsOn: ["2" as never, "3" as never, "20" as never] }),
          task("2"),
          task("3", { stage: "done" }),
        ]),
        entry("b", [task("20")]),
      ],
    });
    expect(map.edges).toEqual([
      {
        id: "waits:task:env/1:task:env/2",
        fromTaskNodeId: "task:env/1",
        toTaskNodeId: "task:env/2",
      },
      {
        id: "waits:task:env/1:task:env/20",
        fromTaskNodeId: "task:env/1",
        toTaskNodeId: "task:env/20",
      },
    ]);
    const first = map.goals[0]!.tasks.find((item) => item.key === "BU-1")!;
    expect(first.waitsOnKeys).toEqual(["BU-2", "BU-20"]);
  });

  it("adds 목표 없음 last, only for unaligned open work", () => {
    const withDone = buildGoalMap({
      entries: [
        director([goalA]),
        entry("a", [task("1")]),
        entry("b", [task("2", { stage: "done" })]),
      ],
    });
    expect(withDone.goals.map((item) => item.id)).toEqual(["a"]);
    const withOpen = buildGoalMap({
      entries: [
        director([goalA]),
        entry("a", [task("1")]),
        entry("b", [task("2"), task("3", { parentTaskId: "2" as never, stage: "inbox" })]),
      ],
    });
    expect(withOpen.goals.map((item) => [item.id, item.title, item.none])).toEqual([
      ["a", "goal a", false],
      ["goal:none", "목표 없음", true],
    ]);
    expect(withOpen.goals[1]!.tasks.map((item) => item.key)).toEqual(["BU-2", "BU-3"]);
  });

  it("excludes Director tasks from nodes but follows them for lineage and waits", () => {
    const map = buildGoalMap({
      entries: [
        director(
          [{ ...goalA, links: [{ projectId: "director" as never, taskId: "epic" as never }] }],
          {
            tasks: [task("epic", { number: 99 })],
            briefing: "  오늘의 브리핑  ",
          },
        ),
        entry("a", [task("1", { parentTaskId: "epic" as never, waitsOn: ["epic" as never] })]),
      ],
    });
    expect(map.briefing).toBe("오늘의 브리핑");
    expect(map.director?.summary.projectId).toBe("director");
    const nodes = map.goals[0]!.tasks;
    expect(nodes.map((item) => item.key)).toEqual(["BU-1"]);
    expect(nodes[0]).toMatchObject({
      status: "blocked",
      parentKey: "BU-99",
      waitsOnKeys: ["BU-99"],
    });
    expect(map.edges).toEqual([]);
  });

  it("keeps the same task id in two environments separate", () => {
    const map = buildGoalMap({
      entries: [
        director([goalA]),
        entry("a", [task("1")]),
        entry("a", [task("1", { stage: "inbox" })], undefined, "other"),
      ],
    });
    expect(map.goals.map((item) => item.id)).toEqual(["a", "goal:none"]);
    expect(map.goals[0]!.tasks.map((item) => item.nodeId)).toEqual(["task:env/1"]);
    expect(map.goals[1]!.tasks.map((item) => item.nodeId)).toEqual(["task:other/1"]);
  });

  it("lays out the same map whatever order entries and tasks arrive in", () => {
    const entries = bigFixture();
    const shuffled = entries
      .map((item) => ({
        ...item,
        summary: { ...item.summary, tasks: item.summary.tasks.toReversed() },
      }))
      .toReversed();
    const a = buildGoalMap({ entries });
    const b = buildGoalMap({ entries: shuffled });
    expect(b.layout).toEqual(a.layout);
    expect(b.goals).toEqual(a.goals);
    expect(b.edges).toEqual(a.edges);
  });

  it("keeps other goals in place when one goal gains tasks", () => {
    const entries = bigFixture();
    const before = buildGoalMap({ entries });
    const grown = entries.map((item) =>
      item.summary.projectId === "p0"
        ? {
            ...item,
            summary: {
              ...item.summary,
              tasks: [...item.summary.tasks, ...[50, 51, 52, 53, 54, 55].map((n) => task(`${n}`))],
            },
          }
        : item,
    );
    const after = buildGoalMap({ entries: grown });
    expect(after.goals[0]!.tasks.length).toBeGreaterThan(before.goals[0]!.tasks.length);
    for (const goalNode of before.goals.slice(1)) {
      expect(after.layout.cells[goalNode.id]).toEqual(before.layout.cells[goalNode.id]);
      expect(after.layout.goalPos[goalNode.id]).toEqual(before.layout.goalPos[goalNode.id]);
      expect(after.layout.dotPos[goalNode.id]).toEqual(before.layout.dotPos[goalNode.id]);
      for (const item of goalNode.tasks) {
        expect(after.layout.taskPos[item.nodeId]).toEqual(before.layout.taskPos[item.nodeId]);
      }
    }
  });

  it("places no overlapping nodes and keeps them inside their cells", () => {
    const map = buildGoalMap({ entries: bigFixture() });
    expect(map.goals).toHaveLength(4);
    expect(Object.keys(map.layout.taskPos)).toHaveLength(20);
    expect([map.layout.width, map.layout.height]).toEqual([
      2 * GOAL_MAP_LAYOUT.cellWidth,
      2 * GOAL_MAP_LAYOUT.cellHeight,
    ]);
    expectNoOverlap(map);
  });

  it("caps rings and dots, counting what did not fit", () => {
    const tasks = Array.from({ length: 25 }, (_, i) => task(`${i + 1}`));
    const done = Array.from({ length: 30 }, (_, i) => task(`${i + 101}`, { stage: "done" }));
    const map = build([...tasks, ...done]);
    const goalNode = map.goals[0]!;
    expect([goalNode.tasks.length, goalNode.overflow]).toEqual([9, 16]);
    expect([goalNode.doneCount, goalNode.hiddenDone]).toEqual([30, 14]);
    expect(map.layout.dotPos.a).toHaveLength(16);
    expectNoOverlap(map);
  });
});

describe("transforms", () => {
  it("fits bounds inside the padded viewport, centered", () => {
    expect(fitTransform({ width: 880, height: 800 }, { width: 472, height: 832 })).toEqual({
      scale: 0.5,
      x: 16,
      y: 216,
    });
    expect(fitTransform({ width: 100, height: 100 }, { width: 220, height: 220 }, 10)).toEqual({
      scale: 2,
      x: 10,
      y: 10,
    });
    expect(fitTransform({ width: 0, height: 0 }, { width: 200, height: 100 })).toEqual({
      scale: 1,
      x: 100,
      y: 50,
    });
  });

  it("zooms to one goal's cell, or the whole map for an unknown goal", () => {
    const map = buildGoalMap({ entries: bigFixture() });
    const viewport = { width: 472, height: 282 };
    const id = map.goals[3]!.id;
    const zoom = zoomToGoal(map.layout, id, viewport);
    const cell = map.layout.cells[id]!;
    expect(zoom.scale).toBe(1);
    expect(cell.x * zoom.scale + zoom.x).toBe(16);
    expect(cell.y * zoom.scale + zoom.y).toBe(16);
    expect(zoomToGoal(map.layout, "missing", viewport)).toEqual(fitTransform(map.layout, viewport));
  });
});

/** Four goals over five projects with twenty open tasks, done work and cross-project waits. */
function bigFixture(): GoalMapEntry[] {
  const goals = [
    goal("g1", 0, ["p0"]),
    goal("g2", 1, ["p1", "p2"]),
    goal("g3", 2, ["p3"]),
    goal("g4", 3, ["p4"]),
  ];
  const projects = [
    [
      task("1"),
      task("2", { stage: "inbox" }),
      task("3", { openQuestion: true }),
      task("4", { stage: "done" }),
    ],
    [
      task("5", { waitsOn: ["9" as never] }),
      task("6"),
      task("7", { stage: "done" }),
      task("23", { stage: "inbox" }),
      task("24"),
    ],
    [task("8", { stage: "blocked" }), task("9"), task("10", { stage: "inbox" }), task("11")],
    [
      task("12"),
      task("13", { stage: "in_review" }),
      task("14", { stage: "planning" }),
      task("15", { waitsOn: ["1" as never] }),
      task("16", { stage: "done" }),
    ],
    [
      task("17"),
      task("18", { openBlocker: true }),
      task("19"),
      task("20"),
      task("21"),
      task("22", { stage: "done" }),
    ],
  ];
  return [director(goals), ...projects.map((tasks, index) => entry(`p${index}`, tasks))];
}

function expectNoOverlap(map: GoalMap) {
  const L = GOAL_MAP_LAYOUT;
  const nodes = [
    ...Object.entries(map.layout.goalPos).map(([id, pos]) => ({ id, ...pos, hit: pos.r })),
    ...Object.entries(map.layout.taskPos).map(([id, pos]) => ({
      id,
      ...pos,
      hit: L.taskHitRadius,
    })),
    ...Object.entries(map.layout.dotPos).flatMap(([id, dots]) =>
      dots.map((pos, i) => ({ id: `${id}#${i}`, ...pos, hit: pos.r })),
    ),
  ];
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) {
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id} vs ${b.id}`).toBeGreaterThanOrEqual(
        a.hit + b.hit,
      );
    }
  }
  for (const goalNode of map.goals) {
    const cell = map.layout.cells[goalNode.id]!;
    const goalPos = map.layout.goalPos[goalNode.id]!;
    const text = map.layout.textPos[goalNode.id]!;
    // The text block sits right under the goal circle, inside the cell.
    expect(text.y - (goalPos.y + goalPos.r)).toBeGreaterThan(0);
    expect(text.y - (goalPos.y + goalPos.r)).toBeLessThanOrEqual(12);
    expect(text.x).toBeLessThan(goalPos.x - goalPos.r);
    expect(text.x + text.width).toBeLessThanOrEqual(cell.x + cell.width);
    expect(text.y + text.height).toBeLessThanOrEqual(cell.y + cell.height);
    for (const item of goalNode.tasks) {
      const pos = map.layout.taskPos[item.nodeId]!;
      // Tasks sit to the right of the goal, inside the cell, clear of the text block.
      expect(pos.x - L.taskHitRadius).toBeGreaterThanOrEqual(goalPos.x + goalPos.r);
      expect(pos.x + L.taskHitRadius).toBeLessThanOrEqual(cell.x + cell.width);
      expect(pos.y - L.taskHitRadius).toBeGreaterThanOrEqual(cell.y);
      expect(pos.y + L.taskHitRadius).toBeLessThanOrEqual(cell.y + cell.height);
      const nearestX = Math.min(Math.max(pos.x, text.x), text.x + text.width);
      const nearestY = Math.min(Math.max(pos.y, text.y), text.y + text.height);
      expect(
        Math.hypot(pos.x - nearestX, pos.y - nearestY),
        `${item.key} vs text`,
      ).toBeGreaterThanOrEqual(L.taskHitRadius);
    }
  }
}
