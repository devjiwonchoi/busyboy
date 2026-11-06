import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useLeadThreadTask } from "~/state/projectTeam";
import { TaskPlanPanel } from "./TaskPlanPanel";

/**
 * A task lead's chat is the task: its plan sits in a panel to the left of the chat. The
 * wrapper always renders so the chat keeps its place in the tree (and stays mounted) when
 * the thread's task loads or a draft is promoted.
 */
export function TaskLeadLayout(props: {
  threadRef: ScopedThreadRef | null;
  projectId: ProjectId | null;
  children: ReactNode;
}) {
  const { threadRef, projectId } = props;
  const leadTask = useLeadThreadTask(threadRef, projectId);
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {leadTask === null || threadRef === null || projectId === null ? null : (
        <TaskPlanPanel
          environmentId={threadRef.environmentId}
          projectId={projectId}
          taskId={leadTask.task.id}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
    </div>
  );
}
