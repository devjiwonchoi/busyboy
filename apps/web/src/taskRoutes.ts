import type { EnvironmentId, ProjectId, ProjectTaskId } from "@t3tools/contracts";

/** Navigation target for a task's page, such as `navigate(taskRouteParams(...))`. */
export function taskRouteParams(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  taskId: ProjectTaskId,
) {
  return {
    to: "/tasks/$environmentId/$projectId/$taskId" as const,
    params: { environmentId, projectId, taskId },
  };
}
