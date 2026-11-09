import type {
  ProjectId,
  ProjectTaskId,
  ProjectTaskStage,
  WorkspaceGoal,
  WorkspaceGoalId,
  WorkspaceGoalLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type AlignableTask, alignWorkspaceGoals } from "./workspaceGoals.js";

const A = "project-a" as ProjectId;
const B = "project-b" as ProjectId;
const DIRECTOR = "director" as ProjectId;
const id = (value: string) => value as ProjectTaskId;

const task = (
  value: string,
  projectId: ProjectId,
  stage: ProjectTaskStage,
  extra: Partial<AlignableTask> = {},
): AlignableTask => ({
  id: id(value),
  projectId,
  parentTaskId: null,
  waitsOn: [],
  stage,
  openQuestion: false,
  openBlocker: false,
  ...extra,
});

const goal = (
  value: string,
  links: ReadonlyArray<WorkspaceGoalLink>,
  status: WorkspaceGoal["status"] = "active",
): WorkspaceGoal => ({
  id: value as WorkspaceGoalId,
  title: value,
  detail: null,
  status,
  position: 0,
  links,
  createdAt: "2026-11-09T00:00:00.000Z" as WorkspaceGoal["createdAt"],
  updatedAt: "2026-11-09T00:00:00.000Z" as WorkspaceGoal["updatedAt"],
});

// Two projects and a Director epic whose subtasks live in project B.
const seed = (epicChildStage: ProjectTaskStage) => ({
  projectIds: [A, B, DIRECTOR],
  tasks: [
    // A1 waits on B2 across projects.
    task("A1", A, "running", { waitsOn: [id("B2")] }),
    task("A2", A, "done"),
    task("A3", A, "running", { openQuestion: true }),
    task("E", DIRECTOR, epicChildStage === "done" ? "done" : "running"),
    task("B1", B, epicChildStage === "done" ? "done" : "blocked", {
      parentTaskId: id("E"),
      openQuestion: epicChildStage !== "done",
      openBlocker: epicChildStage !== "done",
    }),
    task("B2", B, epicChildStage, { parentTaskId: id("E") }),
    // Open top-level work with no goal.
    task("B3", B, "inbox"),
    task("B4", B, "proposed"),
    task("B5", B, "cancelled"),
  ],
  goals: [
    goal("ship-app", [{ projectId: A, taskId: null }]),
    goal("payments", [{ projectId: DIRECTOR, taskId: id("E") }]),
    // Archived goals align nothing, so B3 stays unaligned.
    goal("old", [{ projectId: B, taskId: id("B3") }], "archived"),
  ],
});

describe("alignWorkspaceGoals", () => {
  it("finds contributions, unaligned work and blocked paths across projects", () => {
    const result = alignWorkspaceGoals(seed("running"));
    expect(result.goals).toEqual([
      { goalId: "ship-app", projectIds: [A], taskIds: ["A1", "A2", "A3"] },
      { goalId: "payments", projectIds: [DIRECTOR, B], taskIds: ["E", "B1", "B2"] },
    ]);
    expect(result.unalignedTasks).toEqual([{ projectId: B, taskId: "B3" }]);
    expect(result.goalsWithoutOpenWork).toEqual([]);
    expect(result.blockedPaths).toEqual([
      {
        goalId: "ship-app",
        projectId: A,
        taskId: "A1",
        reasons: ["waits_on"],
        waitsOnTaskIds: ["B2"],
      },
      {
        goalId: "ship-app",
        projectId: A,
        taskId: "A3",
        reasons: ["waiting_on_user"],
        waitsOnTaskIds: [],
      },
      {
        goalId: "payments",
        projectId: B,
        taskId: "B1",
        reasons: ["fatal", "blocked"],
        waitsOnTaskIds: [],
      },
    ]);
  });

  it("flags a goal whose work is all finished and clears waits on finished tasks", () => {
    const result = alignWorkspaceGoals(seed("done"));
    expect(result.goalsWithoutOpenWork).toEqual(["payments"]);
    expect(result.blockedPaths).toEqual([
      {
        goalId: "ship-app",
        projectId: A,
        taskId: "A3",
        reasons: ["waiting_on_user"],
        waitsOnTaskIds: [],
      },
    ]);
  });

  it("treats an active goal with no links as missing work", () => {
    const result = alignWorkspaceGoals({ tasks: [], goals: [goal("empty", [])], projectIds: [] });
    expect(result.goals).toEqual([{ goalId: "empty", projectIds: [], taskIds: [] }]);
    expect(result.goalsWithoutOpenWork).toEqual(["empty"]);
  });

  it("ignores deleted projects and lists open work under a finished parent", () => {
    const GONE = "project-gone" as ProjectId;
    const result = alignWorkspaceGoals({
      projectIds: [A],
      tasks: [
        task("P", A, "cancelled"),
        task("C", A, "running", { parentTaskId: id("P") }),
        task("G", GONE, "running"),
      ],
      goals: [goal("gone", [{ projectId: GONE, taskId: null }])],
    });
    expect(result.goals).toEqual([{ goalId: "gone", projectIds: [], taskIds: [] }]);
    expect(result.unalignedTasks).toEqual([{ projectId: A, taskId: "C" }]);
    expect(result.goalsWithoutOpenWork).toEqual(["gone"]);
  });
});
