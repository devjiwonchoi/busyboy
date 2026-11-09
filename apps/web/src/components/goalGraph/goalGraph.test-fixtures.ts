import type {
  EnvironmentId,
  ProjectDecisionCard,
  ProjectTaskReference,
  WorkspaceGoal,
} from "@t3tools/contracts";
import { makeProjectManagerSummaryFixture } from "~/test-fixtures";

export const GRAPH_NOW = Date.parse("2026-11-09T12:00:00.000Z");
export function graphTask(
  id: string,
  number: number,
  overrides: Partial<ProjectTaskReference> | undefined,
): ProjectTaskReference {
  return {
    id: id as never,
    number,
    title: `작업 ${id}`,
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
    updatedAt: new Date(GRAPH_NOW - 1000).toISOString(),
    checks: null,
    ...overrides,
  };
}
export function graphCard(taskId: string): ProjectDecisionCard {
  return {
    taskNumber: 1,
    taskTitle: "제안",
    plan: null,
    item: {
      id: `card-${taskId}` as never,
      projectId: "a" as never,
      taskId: taskId as never,
      kind: "decision",
      question: "확인해 주세요",
      options: [],
      answer: null,
      answeredAt: null,
      askerThreadId: null,
      batchId: "batch" as never,
      createdAt: new Date(GRAPH_NOW).toISOString(),
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}
export function goalGraphFixture() {
  const goal = (
    id: string,
    position: number,
    projectId: string,
    taskId: string | null,
  ): WorkspaceGoal => ({
    id: id as never,
    title: `목표 ${position + 1}`,
    position,
    detail: null,
    status: "active",
    links: [{ projectId: projectId as never, taskId: taskId as never }],
    createdAt: new Date(GRAPH_NOW).toISOString(),
    updatedAt: new Date(GRAPH_NOW).toISOString(),
  });
  const entry = (id: string, tasks: ProjectTaskReference[]) => ({
    environmentId: "env-1" as EnvironmentId,
    summary: makeProjectManagerSummaryFixture({
      projectId: id as never,
      pmThreadId: `pm-${id}` as never,
      taskKeyPrefix: id.toUpperCase(),
      tasks,
    }),
  });
  const a = entry("a", [
    graphTask("a-1", 1, undefined),
    graphTask("a-2", 2, { stage: "planning" }),
    graphTask("a-3", 3, { parentTaskId: "a-1" as never, stage: "in_review" }),
    graphTask("a-4", 4, { stage: "done" }),
    graphTask("a-old", 5, {
      stage: "done",
      updatedAt: new Date(GRAPH_NOW - 2 * 86400000).toISOString(),
    }),
    graphTask("a-cancelled", 6, { stage: "cancelled" }),
  ]);
  const b = entry("b", [
    graphTask("b-1", 1, { waitsOn: ["a-2" as never] }),
    graphTask("b-2", 2, { stage: "planning" }),
    graphTask("b-3", 3, { parentTaskId: "b-2" as never, stage: "planning" }),
  ]);
  const director = entry("director", []);
  return [
    a,
    b,
    {
      ...director,
      summary: {
        ...director.summary,
        kind: "director" as const,
        goals: [
          goal("goal-1", 0, "a", null),
          goal("goal-2", 1, "b", "b-1"),
          goal("goal-3", 2, "b", "missing"),
        ],
        decisionCards: [],
      },
    },
  ].map((item) =>
    item.summary.projectId === "a"
      ? { ...item, summary: { ...item.summary, decisionCards: [graphCard("a-1")] } }
      : item,
  );
}

/** A recent running lead and waiting work across two projects exercise signal rollups. */
export function goalGraphSignalsFixture() {
  const entries = goalGraphFixture();
  for (const entry of entries) {
    entry.summary = {
      ...entry.summary,
      tasks: entry.summary.tasks.map((task) => ({
        ...task,
        updatedAt: new Date(
          GRAPH_NOW - (task.id === "a-1" ? 3 * 3600000 : 2 * 86400000),
        ).toISOString(),
        leadThreadId: task.id === "a-1" ? ("lead-a-1" as never) : null,
      })),
    };
  }
  const b = entries[1]!;
  b.summary = {
    ...b.summary,
    decisionCards: [
      {
        ...graphCard("b-1"),
        item: { ...graphCard("b-1").item, projectId: "b" as never },
      },
    ],
  };
  const director = entries[2]!;
  director.summary = {
    ...director.summary,
    briefing: "목표 2는 결정 1건에 막혀 있어요",
    goals: (director.summary.goals ?? []).map((goal, index) =>
      index === 0
        ? { ...goal, links: [...goal.links, { projectId: "b" as never, taskId: "b-1" as never }] }
        : goal,
    ),
  };
  return entries;
}
