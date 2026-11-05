import type { ProjectTaskReference } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleEllipsisIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  GitPullRequestArrowIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { TASK_STAGE_LABELS } from "../chat/taskReferences.logic";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type SidebarRowStatusIcon =
  | "working"
  | "waiting"
  | "input"
  | "approval"
  | "failed"
  | "done"
  // Task stages, for a project manager's task-lead rows.
  | "inbox"
  | "planning"
  | "running"
  | "review"
  | "stalled"
  | "blocked"
  | "cancelled";

export interface SidebarRowStatus {
  readonly label: string;
  readonly icon: SidebarRowStatusIcon;
  readonly className: string;
}

export function resolveSidebarRowStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly goalActive: boolean;
}): SidebarRowStatus | null {
  switch (input.status) {
    case "working":
      return {
        label: input.goalActive ? "Goal" : "Working",
        icon: "working",
        className: "text-info",
      };
    case "waiting":
      return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
    case "input":
      return {
        label: "Input",
        icon: "input",
        className: "text-indigo-600 dark:text-indigo-300",
      };
    case "limited":
      return { label: "Limited", icon: "failed", className: "text-warning" };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error" };
    case "ready":
      return input.isUnread ? { label: "Done", icon: "done", className: "text-success" } : null;
  }
}

const LIVE_TASK_STAGES: ReadonlySet<ProjectTaskReference["stage"]> = new Set([
  "planning",
  "running",
  "in_review",
]);

/** "PR #81" for a GitHub-style pull request URL, otherwise "PR". */
export function formatTaskPullRequestLabel(prUrl: string): string {
  const number = /\/pull\/(\d+)(?:[/?#]|$)/u.exec(prUrl)?.[1];
  return number === undefined ? "PR" : `PR #${number}`;
}

/**
 * The status of a task stage alone, e.g. "In review · PR #81". Every stage has an
 * icon, so a task never looks idle or stuck.
 */
export function resolveTaskStageStatus(
  task: Pick<ProjectTaskReference, "stage" | "prUrl" | "lastOutcome">,
): SidebarRowStatus {
  if (task.lastOutcome === "stalled" && LIVE_TASK_STAGES.has(task.stage)) {
    return {
      label: `Stalled · ${TASK_STAGE_LABELS[task.stage]}`,
      icon: "stalled",
      className: "text-warning",
    };
  }
  const label = TASK_STAGE_LABELS[task.stage];
  switch (task.stage) {
    case "inbox":
      return { label, icon: "inbox", className: "text-muted-foreground" };
    case "planning":
      return { label, icon: "planning", className: "text-info" };
    case "running":
      return { label, icon: "running", className: "text-info" };
    case "in_review":
      return {
        label: task.prUrl === null ? label : `${label} · ${formatTaskPullRequestLabel(task.prUrl)}`,
        icon: "review",
        className: "text-violet-600 dark:text-violet-300",
      };
    case "done":
      return { label, icon: "done", className: "text-success" };
    case "blocked":
      return { label, icon: "blocked", className: "text-warning" };
    case "cancelled":
      return { label, icon: "cancelled", className: "text-muted-foreground/70" };
  }
}

/**
 * A task lead's row: what asks something of the user first, then live thread
 * activity, then the task's stage. Never null.
 */
export function resolveSidebarTaskRowStatus(input: {
  readonly threadStatus: SidebarRowStatus | null;
  readonly task: Pick<ProjectTaskReference, "stage" | "prUrl" | "lastOutcome">;
  readonly waitingOnUser: boolean;
}): SidebarRowStatus {
  const { threadStatus } = input;
  if (threadStatus?.icon === "approval" || threadStatus?.icon === "input") return threadStatus;
  if (input.waitingOnUser) {
    return { label: "Needs you", icon: "input", className: "text-indigo-600 dark:text-indigo-300" };
  }
  if (threadStatus?.icon === "working" || threadStatus?.icon === "failed") return threadStatus;
  return resolveTaskStageStatus(input.task);
}

const statusIconClassName = "size-4 shrink-0";

export function StatusGlyph(props: { icon: SidebarRowStatusIcon }) {
  switch (props.icon) {
    case "working":
      return (
        <CircleDashedIcon
          aria-hidden
          className={cn(
            statusIconClassName,
            "animate-spin [animation-duration:2.5s] motion-reduce:animate-none",
          )}
        />
      );
    case "waiting":
      return <CircleDotDashedIcon aria-hidden className={statusIconClassName} />;
    case "input":
      return <MessageCircleQuestionIcon aria-hidden className={statusIconClassName} />;
    case "approval":
      return <ShieldQuestionIcon aria-hidden className={statusIconClassName} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={statusIconClassName} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={statusIconClassName} />;
    case "inbox":
      return <CircleIcon aria-hidden className={statusIconClassName} />;
    case "planning":
      return <CircleEllipsisIcon aria-hidden className={statusIconClassName} />;
    case "running":
      return <CircleDashedIcon aria-hidden className={statusIconClassName} />;
    case "review":
      return <GitPullRequestArrowIcon aria-hidden className={statusIconClassName} />;
    case "stalled":
      return <CirclePauseIcon aria-hidden className={statusIconClassName} />;
    case "blocked":
      return <CircleSlashIcon aria-hidden className={statusIconClassName} />;
    case "cancelled":
      return <CircleXIcon aria-hidden className={statusIconClassName} />;
  }
}

// A fixed-width slot at the row's far right so titles align whether or not a
// row has a status. The label stays in the accessibility tree as the live region.
export function SidebarRowStatusSlot(props: { status: SidebarRowStatus | null }) {
  const { status } = props;
  return (
    <span
      data-testid="sidebar-row-status"
      data-status={status?.icon}
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", status?.className)}
    >
      {status ? (
        <>
          <StatusGlyph icon={status.icon} />
          <span role="status" className="sr-only">
            {status.label}
          </span>
        </>
      ) : null}
    </span>
  );
}

// One sidebar row line: the title owns every pixel on the left, everything else
// sits in one trailing slot at the right. The slot stacks two layers in the same
// grid cell, both right-aligned: at rest, the passive indicators and the status
// icon; on hover or keyboard focus, the row actions. The slot is always as wide
// as the wider layer, so swapping layers never moves the actions or reflows the
// title.
export function SidebarRowLine(props: {
  title: ReactNode;
  status: SidebarRowStatus | null;
  indicators?: ReactNode;
  actions?: ReactNode;
  // Replaces the whole trailing slot, e.g. the drop destination while dragging.
  trailingOverride?: ReactNode;
}) {
  const hasActions = props.actions != null && props.actions !== false;
  // focus-visible, not focus-within: a mouse click leaves the clicked button
  // focused, and focus-within would keep the actions shown after the pointer leaves.
  const showActions =
    "group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 group-has-[:focus-visible]/sidebar-row-trailing:pointer-events-auto group-has-[:focus-visible]/sidebar-row-trailing:opacity-100";
  const hideResting =
    "group-any-hover/sidebar-row:opacity-0 group-has-[:focus-visible]/sidebar-row-trailing:opacity-0";
  return (
    <div className="relative z-10 flex h-8 min-w-0 items-center gap-1.5 px-(--sidebar-row-content-inset)">
      <div className="flex min-w-0 flex-1 items-center">{props.title}</div>
      {props.trailingOverride != null ? (
        props.trailingOverride
      ) : (
        <span
          data-testid="sidebar-row-trailing"
          className="group/sidebar-row-trailing grid h-5 shrink-0 items-center justify-items-end"
        >
          {/* Opacity, not visibility, so the status label stays announced on hover. */}
          <span
            className={cn(
              "pointer-events-none col-start-1 row-start-1 flex items-center gap-1.5 transition-opacity motion-reduce:transition-none",
              hasActions && hideResting,
            )}
          >
            {props.indicators}
            <SidebarRowStatusSlot status={props.status} />
          </span>
          {hasActions ? (
            <span
              data-testid="sidebar-row-actions"
              className={cn(
                "pointer-events-none col-start-1 row-start-1 flex h-full items-stretch opacity-0 transition-opacity motion-reduce:transition-none",
                showActions,
              )}
            >
              {props.actions}
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}

export function SidebarRowActionButton(props: {
  label: string;
  onClick: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
