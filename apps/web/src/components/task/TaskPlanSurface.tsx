import type { ScopedThreadRef } from "@t3tools/contracts";
import { ClipboardListIcon } from "lucide-react";

import { useThreadShell } from "~/state/entities";
import { useLeadThreadTask } from "~/state/projectTeam";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskPlan } from "./TaskPlan";

/** The task's plan as a tab in its lead thread's right panel. */
export function TaskPlanSurface(props: { readonly threadRef: ScopedThreadRef }) {
  const projectId = useThreadShell(props.threadRef)?.projectId ?? null;
  const leadTask = useLeadThreadTask(props.threadRef, projectId);
  if (leadTask === null || projectId === null) return null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="task-plan-surface">
      <TaskPlan
        environmentId={props.threadRef.environmentId}
        projectId={projectId}
        taskId={leadTask.task.id}
        className="px-4 pt-3 pb-8"
      />
    </div>
  );
}

/** The chat header's way to a task's plan: opens the right panel on the Plan tab. */
export function TaskPlanToggle(props: { readonly threadRef: ScopedThreadRef }) {
  const showing = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, props.threadRef) === "task-plan",
  );
  // While the plan is on screen its own tab is the control; the header only brings it back.
  if (showing) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Show plan"
            onClick={() => useRightPanelStore.getState().open(props.threadRef, "task-plan")}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <ClipboardListIcon aria-hidden className="size-3.5" />
        Plan
      </TooltipTrigger>
      <TooltipPopup side="bottom">Show the task's plan</TooltipPopup>
    </Tooltip>
  );
}
