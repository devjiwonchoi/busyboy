import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ProjectTaskId } from "@t3tools/contracts";
import { Navigate } from "@tanstack/react-router";

import { useThreadShell } from "~/state/entities";
import { useTaskDetail } from "~/state/projectTeam";
import { buildThreadRouteParams } from "~/threadRoutes";
import { TaskPlan } from "./TaskPlan";

export interface TaskPageProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectTaskId;
}

/**
 * A task is its lead's session: once the lead's chat exists, the task URL forwards to it,
 * where the plan sits in a panel on the left. A task with no lead yet shows only its plan.
 */
export function TaskPage(props: TaskPageProps) {
  const { environmentId, projectId, taskId } = props;
  const detail = useTaskDetail(environmentId, { projectId, taskId }).data;
  const leadThreadId = detail?.task.leadThreadId ?? null;
  const leadRef = leadThreadId === null ? null : scopeThreadRef(environmentId, leadThreadId);
  const leadThread = useThreadShell(leadRef);
  if (leadRef !== null && leadThread !== null && leadThread.deletedAt == null) {
    return (
      <Navigate to="/$environmentId/$threadId" params={buildThreadRouteParams(leadRef)} replace />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto" data-testid="task-page">
      <TaskPlan
        environmentId={environmentId}
        projectId={projectId}
        taskId={taskId}
        className="mx-auto w-full max-w-3xl px-5 pt-14 pb-10 md:px-8 md:pt-8"
      />
    </div>
  );
}
