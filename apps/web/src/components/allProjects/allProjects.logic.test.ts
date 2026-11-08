import type {
  EnvironmentId,
  ProjectDecisionCard,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { buildTaskRelationsIndex } from "../task/taskRelations.logic";
import {
  buildMapArrows,
  buildProjectMap,
  goalProgress,
  longestWaiting,
  needsYouOf,
  selectGoals,
} from "./allProjects.logic";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const env = "env-1" as EnvironmentId;

function task(
  id: string,
  number: number,
  overrides: Partial<ProjectTaskReference> = {},
): ProjectTaskReference {
  return {
    id: id as never,
    number,
    parentTaskId: null,
    waitsOn: [],
    title: `Task ${number}`,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: new Date(NOW - DAY).toISOString(),
    checks: null,
    ...overrides,
  };
}

const checks = (...passed: boolean[]) =>
  passed.map((value, index) => ({ text: `check ${index + 1}`, passed: value }));

function card(id: string, kind: string, createdAt: string, closed = false): ProjectDecisionCard {
  return {
    taskNumber: 1,
    taskTitle: "Task 1",
    plan: null,
    proposal: null,
    item: {
      id: id as never,
      projectId: "p" as never,
      taskId: "t" as never,
      kind: kind as never,
      question: "?",
      options: [],
      answer: closed ? "ok" : null,
      answeredAt: closed ? createdAt : null,
      askerThreadId: null,
      batchId: "b" as never,
      createdAt,
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}

function project(
  projectId: string,
  tasks: ProjectTaskReference[],
  overrides: Partial<Omit<ProjectTeamAttentionSummary, "presence">> = {},
) {
  return {
    environmentId: env,
    summary: makeProjectManagerSummaryFixture({
      projectId: projectId as never,
      taskKeyPrefix: projectId.toUpperCase(),
      tasks,
      ...overrides,
    }),
  };
}

describe("selectGoals", () => {
  it("keeps top-level tasks, drops cancelled and week-old done ones, and sorts by phase", () => {
    const goals = selectGoals(
      [
        task("done-old", 1, { stage: "done", updatedAt: new Date(NOW - 8 * DAY).toISOString() }),
        task("done-new", 2, { stage: "done", checks: checks(true) }),
        task("cancelled", 3, { stage: "cancelled" }),
        task("planning", 4, { stage: "planning", checks: [] }),
        task("waiting", 5, { stage: "awaiting_approval", checks: checks(false) }),
        task("running", 6, { stage: "running", checks: checks(true, false) }),
        task("sub", 7, { parentTaskId: "running" as never }),
        // A Director epic's subtask: its parent lives in another project.
        task("epic-child", 8, { parentTaskId: "epic-elsewhere" as never, stage: "in_review" }),
        // A proposal the user hasn't added yet.
        task("proposal", 9, { stage: "proposed" }),
      ],
      NOW,
    );
    expect(goals.map((goal) => [goal.task.id, goal.phase])).toEqual([
      ["running", "active"],
      ["epic-child", "active"],
      ["waiting", "waiting"],
      ["planning", "planning"],
      ["done-new", "done"],
    ]);
  });
});

describe("goalProgress", () => {
  it("counts passed checks over all checks and leaves planning goals out", () => {
    const goals = selectGoals(
      [
        task("a", 1, { checks: checks(true, true, false) }),
        task("b", 2, { stage: "done", checks: checks(true) }),
        task("c", 3, { stage: "planning", checks: [] }),
      ],
      NOW,
    );
    expect(goalProgress(goals)).toEqual({ passed: 3, total: 4, percent: 75 });
  });

  it("is null with no goals and 0% when every goal is still being planned", () => {
    expect(goalProgress([])).toBeNull();
    expect(goalProgress(selectGoals([task("a", 1, { stage: "inbox" })], NOW))).toEqual({
      passed: 0,
      total: 0,
      percent: 0,
    });
  });
});

describe("needsYouOf", () => {
  it("counts open cards by kind and finds the oldest", () => {
    const needs = needsYouOf({
      decisionCards: [
        card("1", "approval", "2026-11-08T10:00:00.000Z"),
        card("2", "decision", "2026-11-08T09:00:00.000Z"),
        card("3", "decision", "2026-11-08T11:00:00.000Z"),
        card("4", "proposal", "2026-11-08T11:30:00.000Z"),
        card("5", "approval", "2026-11-08T08:00:00.000Z", true),
      ],
    });
    expect(needs).toEqual({
      total: 4,
      label: "플랜 승인 1 · 질문 2 · 제안 1",
      oldestAt: "2026-11-08T09:00:00.000Z",
    });
  });
});

describe("buildProjectMap", () => {
  it("puts projects waiting on the user first, then working ones, then the rest", () => {
    const map = buildProjectMap(
      [
        project("idle", [
          task("i1", 1, { stage: "inbox", updatedAt: new Date(NOW).toISOString() }),
        ]),
        project("busy", [task("b1", 1, { stage: "running" })]),
        project("asks", [task("a1", 1, { stage: "inbox" })], {
          decisionCards: [card("c", "approval", "2026-11-08T10:00:00.000Z")],
        }),
      ],
      NOW,
    );
    expect(map.map((item) => item.summary.projectId)).toEqual(["asks", "busy", "idle"]);
    expect(map[1]!.now).toEqual(["Task 1"]);
    expect(map[0]!.next).toEqual(["Task 1"]);
    expect(longestWaiting(map)?.summary.projectId).toBe("asks");
  });
});

describe("buildMapArrows", () => {
  it("draws an arrow from a goal to the goal it waits on in another project", () => {
    const entries = [
      project("web", [
        task("web-goal", 1, { checks: checks(false) }),
        // A subtask waits; the arrow starts at its goal.
        task("web-sub", 2, { parentTaskId: "web-goal" as never, waitsOn: ["api-sub" as never] }),
        task("web-same", 3, { waitsOn: ["web-goal" as never] }),
      ]),
      project("api", [
        task("api-goal", 1, { title: "API 목표", checks: checks(true) }),
        task("api-sub", 2, { parentTaskId: "api-goal" as never }),
      ]),
    ];
    const map = buildProjectMap(entries, NOW);
    const arrows = buildMapArrows(map, buildTaskRelationsIndex(entries));
    expect(arrows).toEqual([
      {
        from: { environmentId: env, projectId: "web", taskId: "web-goal" },
        to: { environmentId: env, projectId: "api", taskId: "api-goal" },
        toGoalTitle: "API 목표",
      },
    ]);
  });

  it("ignores proposals the user hasn't added, on either end", () => {
    const entries = [
      project("web", [
        task("web-goal", 1),
        task("web-proposal", 2, {
          parentTaskId: "web-goal" as never,
          stage: "proposed",
          waitsOn: ["api-goal" as never],
        }),
        task("web-sub", 3, {
          parentTaskId: "web-goal" as never,
          waitsOn: ["api-proposal" as never],
        }),
      ]),
      project("api", [
        task("api-goal", 1),
        task("api-proposal", 2, { parentTaskId: "api-goal" as never, stage: "proposed" }),
      ]),
    ];
    const map = buildProjectMap(entries, NOW);
    expect(buildMapArrows(map, buildTaskRelationsIndex(entries))).toEqual([]);
  });

  it("draws nothing once the awaited task is finished", () => {
    const entries = [
      project("web", [task("web-goal", 1, { waitsOn: ["api-goal" as never] })]),
      project("api", [task("api-goal", 1, { stage: "done" })]),
    ];
    const map = buildProjectMap(entries, NOW);
    expect(buildMapArrows(map, buildTaskRelationsIndex(entries))).toEqual([]);
  });
});
