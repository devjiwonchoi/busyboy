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
export function graphCard(taskId: string, proposal: boolean): ProjectDecisionCard {
  return {
    taskNumber: 1,
    taskTitle: "제안",
    plan: null,
    proposal: proposal ? { projectId: "a" as never } : null,
    item: {
      id: `card-${taskId}` as never,
      projectId: (proposal ? "director" : "a") as never,
      taskId: taskId as never,
      kind: proposal ? "proposal" : "decision",
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
  const director = entry("director", [graphTask("proposal", 1, { stage: "proposed" })]);
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
        decisionCards: [graphCard("proposal", true)],
      },
    },
  ].map((item) =>
    item.summary.projectId === "a"
      ? { ...item, summary: { ...item.summary, decisionCards: [graphCard("a-1", false)] } }
      : item,
  );
}
