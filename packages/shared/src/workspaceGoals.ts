/**
 * Lines the workspace's tasks up with the user's goals. Shared by the server (team_status
 * and the attention snapshot) and the web (the goal graph).
 */

import type {
  ProjectId,
  ProjectTaskId,
  ProjectTaskStage,
  WorkspaceBlockReason,
  WorkspaceBlockedPath,
  WorkspaceGoal,
  WorkspaceGoalAlignment,
  WorkspaceGoalId,
  WorkspaceTaskRef,
} from "@t3tools/contracts";

/** The fields of a task that alignment reads. */
export interface AlignableTask {
  readonly id: ProjectTaskId;
  readonly projectId: ProjectId;
  readonly parentTaskId: ProjectTaskId | null;
  readonly waitsOn: ReadonlyArray<ProjectTaskId>;
  readonly stage: ProjectTaskStage;
  /** A question or blocker card from this task waits on the user. */
  readonly openQuestion: boolean;
  /** One of those is a blocker card. */
  readonly openBlocker: boolean;
}

const isFinished = (stage: ProjectTaskStage) => stage === "done" || stage === "cancelled";
const isOpen = (stage: ProjectTaskStage) => !isFinished(stage);

/**
 * A task serves an active goal when the goal links it, one of its ancestors (parents may
 * be in other projects, such as a Director epic), or its project. Tasks and links outside
 * `projectIds`, such as a deleted project's, are ignored.
 */
export function alignWorkspaceGoals(input: {
  readonly goals: ReadonlyArray<WorkspaceGoal>;
  readonly tasks: ReadonlyArray<AlignableTask>;
  /** The workspace's live projects, the Director's own included. */
  readonly projectIds: ReadonlyArray<ProjectId>;
}): WorkspaceGoalAlignment {
  const live = new Set<string>(input.projectIds);
  const tasks = input.tasks.filter((task) => live.has(task.projectId));
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const activeGoals = input.goals.filter((goal) => goal.status === "active");

  // The task itself first, then its parents up the chain; stops on a cycle or unknown parent.
  const lineage = (task: AlignableTask): ReadonlyArray<AlignableTask> => {
    const chain: Array<AlignableTask> = [];
    const seen = new Set<string>();
    let current: AlignableTask | undefined = task;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.parentTaskId === null ? undefined : byId.get(current.parentTaskId);
    }
    return chain;
  };

  const contributions = activeGoals.map((goal) => {
    const linkedProjects = new Set<string>();
    const linkedTasks = new Set<string>();
    const links = goal.links.filter((link) => live.has(link.projectId));
    for (const link of links) {
      if (link.taskId === null) linkedProjects.add(link.projectId);
      else linkedTasks.add(link.taskId);
    }
    const contributing = tasks.filter(
      (task) =>
        task.stage !== "cancelled" &&
        (linkedProjects.has(task.projectId) ||
          lineage(task).some((link) => linkedTasks.has(link.id))),
    );
    const projectIds: Array<ProjectId> = [];
    const addProject = (projectId: ProjectId) => {
      if (!projectIds.includes(projectId)) projectIds.push(projectId);
    };
    for (const link of links) if (link.taskId === null) addProject(link.projectId);
    for (const task of contributing) addProject(task.projectId);
    return { goal, contributing, projectIds };
  });

  const served = new Set<string>();
  for (const { contributing } of contributions) {
    for (const task of contributing) served.add(task.id);
  }

  // Open work is top-level when no open task above it carries it.
  const isTopLevel = (task: AlignableTask) => {
    const parent = task.parentTaskId === null ? undefined : byId.get(task.parentTaskId);
    return parent === undefined || !isOpen(parent.stage);
  };
  const unalignedTasks: Array<WorkspaceTaskRef> = tasks
    .filter((task) => isOpen(task.stage) && isTopLevel(task) && !served.has(task.id))
    .map((task) => ({ projectId: task.projectId, taskId: task.id }));

  const goalsWithoutOpenWork: Array<WorkspaceGoalId> = contributions
    .filter(({ contributing }) => !contributing.some((task) => isOpen(task.stage)))
    .map(({ goal }) => goal.id);

  const blockedPaths: Array<WorkspaceBlockedPath> = [];
  for (const { goal, contributing } of contributions) {
    for (const task of contributing) {
      if (!isOpen(task.stage)) continue;
      const reasons: Array<WorkspaceBlockReason> = [];
      if (task.openBlocker) reasons.push("fatal");
      else if (task.openQuestion) reasons.push("waiting_on_user");
      if (task.stage === "blocked") reasons.push("blocked");
      const waitsOnTaskIds = task.waitsOn.filter((id) => {
        const dependency = byId.get(id);
        return dependency !== undefined && !isFinished(dependency.stage);
      });
      if (waitsOnTaskIds.length > 0) reasons.push("waits_on");
      if (reasons.length === 0) continue;
      blockedPaths.push({
        goalId: goal.id,
        projectId: task.projectId,
        taskId: task.id,
        reasons,
        waitsOnTaskIds,
      });
    }
  }

  return {
    goals: contributions.map(({ goal, contributing, projectIds }) => ({
      goalId: goal.id,
      projectIds,
      taskIds: contributing.map((task) => task.id),
    })),
    unalignedTasks,
    goalsWithoutOpenWork,
    blockedPaths,
  };
}
