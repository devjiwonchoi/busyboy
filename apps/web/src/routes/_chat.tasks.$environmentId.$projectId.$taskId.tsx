import { EnvironmentId, ProjectId, ProjectTaskId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { TaskPage } from "../components/task/TaskPage";
import { SidebarInset } from "../components/ui/sidebar";

export const Route = createFileRoute("/_chat/tasks/$environmentId/$projectId/$taskId")({
  component: TaskRouteView,
});

function TaskRouteView() {
  const params = Route.useParams();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <TaskPage
        key={params.taskId}
        environmentId={EnvironmentId.make(params.environmentId)}
        projectId={ProjectId.make(params.projectId)}
        taskId={ProjectTaskId.make(params.taskId)}
      />
    </SidebarInset>
  );
}
