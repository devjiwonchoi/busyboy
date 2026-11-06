import type { EnvironmentId, ProjectId, ProjectTaskId } from "@t3tools/contracts";
import { PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import {
  TASK_PLAN_PANEL_DEFAULT_WIDTH,
  clampTaskPlanPanelWidth,
  useTaskPlanPanelStore,
} from "~/taskPlanPanelStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskPlan } from "./TaskPlan";

export interface TaskPlanPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectTaskId;
}

/**
 * The task's plan beside its lead's chat: a resizable, collapsible column on the left on
 * desktop, and a bottom sheet opened from the chat header's "Plan" button on phones.
 */
export function TaskPlanPanel(props: TaskPlanPanelProps) {
  const isMobile = useIsMobile();
  return isMobile ? <TaskPlanSheet {...props} /> : <TaskPlanColumn {...props} />;
}

function TaskPlanColumn(props: TaskPlanPanelProps) {
  const open = useTaskPlanPanelStore((state) => state.open);
  const width = useTaskPlanPanelStore((state) => state.width);
  const setOpen = useTaskPlanPanelStore((state) => state.setOpen);
  const setWidth = useTaskPlanPanelStore((state) => state.setWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  if (!open) return null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return;
    setWidth(drag.current.startWidth + event.clientX - drag.current.startX);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <aside
      aria-label="Task plan"
      className="relative flex min-h-0 shrink-0 flex-col border-r"
      style={{ width }}
      data-testid="task-plan-panel"
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 pr-2 pl-(--workspace-gutter-start)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Plan
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Hide plan"
          onClick={() => setOpen(false)}
        >
          <PanelLeftCloseIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskPlan {...props} className="px-4 pt-2 pb-8" />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize plan"
        aria-valuemin={260}
        aria-valuemax={640}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-border/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setWidth(TASK_PLAN_PANEL_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setWidth(clampTaskPlanPanelWidth(width - 16));
          if (event.key === "ArrowRight") setWidth(clampTaskPlanPanelWidth(width + 16));
        }}
      />
    </aside>
  );
}

function TaskPlanSheet(props: TaskPlanPanelProps) {
  const open = useTaskPlanPanelStore((state) => state.mobileOpen);
  const setOpen = useTaskPlanPanelStore((state) => state.setMobileOpen);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* From the bottom, so it clears the app's fixed buttons along the top edge. */}
      <SheetPopup
        side="bottom"
        className="h-[85svh] max-h-[85svh] rounded-t-2xl"
        data-testid="task-plan-sheet"
      >
        <SheetTitle className="px-4 pt-4 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Plan
        </SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskPlan {...props} className="px-4 pt-3 pb-10" />
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/** Shows or hides a task lead's plan panel; on phones it opens the plan sheet. */
export function TaskPlanToggle() {
  const isMobile = useIsMobile();
  const open = useTaskPlanPanelStore((state) => (isMobile ? state.mobileOpen : state.open));
  const setOpen = useTaskPlanPanelStore((state) =>
    isMobile ? state.setMobileOpen : state.setOpen,
  );
  // The desktop panel has its own hide button, so the header only offers to bring it back.
  if (open && !isMobile) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Show plan"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <PanelLeftIcon aria-hidden className="size-3.5" />
        Plan
      </TooltipTrigger>
      <TooltipPopup side="bottom">Show the task's plan</TooltipPopup>
    </Tooltip>
  );
}
