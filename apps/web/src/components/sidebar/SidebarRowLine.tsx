import {
  PROJECT_TASK_STATUS_LABELS,
  type ProjectTaskReference,
  type ProjectTaskStatus,
} from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleEllipsisIcon,
  CircleIcon,
  ClipboardCheckIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  MessageCircleQuestionIcon,
  OctagonAlertIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A plain thread's live state, or a task's user-facing status (prefixed "task-"). */
export type SidebarRowStatusIcon =
  | "working"
  | "waiting"
  | "input"
  | "approval"
  | "failed"
  | "done"
  | `task-${ProjectTaskStatus}`;

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

/** "PR #81" for a GitHub-style pull request URL, otherwise "PR". */
export function formatTaskPullRequestLabel(prUrl: string): string {
  const number = /\/pull\/(\d+)(?:[/?#]|$)/u.exec(prUrl)?.[1];
  return number === undefined ? "PR" : `PR #${number}`;
}

const TASK_STATUS_CLASS_NAMES: Record<ProjectTaskStatus, string> = {
  todo: "text-muted-foreground",
  planning: "text-orange-600 dark:text-orange-300",
  waiting_for_approval: "text-warning-foreground",
  in_progress: "text-info",
  in_review: "text-violet-600 dark:text-violet-300",
  ready: "text-success",
  ask_question: "text-indigo-600 dark:text-indigo-300",
  fatal: "text-error",
  done: "text-muted-foreground/70",
};

/**
 * How a task's status looks: one icon and color per status, and a label such as
 * "Ready · PR #81". A cancelled task is Done too, labeled "Done · cancelled".
 */
export function describeTaskStatus(
  status: ProjectTaskStatus,
  task: Pick<ProjectTaskReference, "stage" | "prUrl">,
): SidebarRowStatus {
  const base = PROJECT_TASK_STATUS_LABELS[status];
  const withPr =
    (status === "in_review" || status === "ready") && task.prUrl !== null
      ? `${base} · ${formatTaskPullRequestLabel(task.prUrl)}`
      : base;
  const label = status === "done" && task.stage === "cancelled" ? `${base} · cancelled` : withPr;
  return { label, icon: `task-${status}`, className: TASK_STATUS_CLASS_NAMES[status] };
}

const statusIconClassName = "size-4 shrink-0";

export function StatusGlyph(props: { icon: SidebarRowStatusIcon }) {
  switch (props.icon) {
    // An in-progress task spins like a working thread: both mean an agent is at work.
    case "working":
    case "task-in_progress":
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
    case "task-todo":
      return <CircleIcon aria-hidden className={statusIconClassName} />;
    case "task-planning":
      return <CircleEllipsisIcon aria-hidden className={statusIconClassName} />;
    case "task-waiting_for_approval":
      return <ClipboardCheckIcon aria-hidden className={statusIconClassName} />;
    case "task-in_review":
      return <GitPullRequestArrowIcon aria-hidden className={statusIconClassName} />;
    case "task-ready":
      return <GitMergeIcon aria-hidden className={statusIconClassName} />;
    case "task-ask_question":
      return <MessageCircleQuestionIcon aria-hidden className={statusIconClassName} />;
    case "task-fatal":
      return <OctagonAlertIcon aria-hidden className={statusIconClassName} />;
    case "task-done":
      return <CircleCheckIcon aria-hidden className={statusIconClassName} />;
  }
}

const LONG_PRESS_MS = 500;
const TOUCH_LABEL_MS = 2000;

/**
 * A status icon that names itself: the label shows on hover, and on a phone on
 * long-press. A long-press only shows the label; it doesn't click the row.
 */
export function StatusGlyphWithLabel(props: { status: SidebarRowStatus }) {
  return (
    <GlyphWithLabel label={props.status.label}>
      <StatusGlyph icon={props.status.icon} />
    </GlyphWithLabel>
  );
}

/** Any icon that names itself the same way: on hover, or on a phone on long-press. */
export function GlyphWithLabel(props: { label: string; children: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(
    () => () => {
      clearPress();
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <span
            data-testid={props.testId ?? "status-glyph-trigger"}
            className="pointer-events-auto inline-flex select-none [-webkit-touch-callout:none]"
            onPointerDown={(event) => {
              longPressed.current = false;
              if (event.pointerType === "mouse") return;
              clearPress();
              pressTimer.current = setTimeout(() => {
                longPressed.current = true;
                setOpen(true);
                if (hideTimer.current !== null) clearTimeout(hideTimer.current);
                hideTimer.current = setTimeout(() => setOpen(false), TOUCH_LABEL_MS);
              }, LONG_PRESS_MS);
            }}
            onPointerUp={clearPress}
            onPointerCancel={clearPress}
            onPointerLeave={clearPress}
            // Phones open a context menu on long-press; the label replaces it.
            onContextMenu={(event) => {
              if (pressTimer.current !== null || longPressed.current) event.preventDefault();
            }}
            onClick={(event) => {
              if (!longPressed.current) return;
              longPressed.current = false;
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function isTaskStatus(status: SidebarRowStatus): boolean {
  return status.icon.startsWith("task-");
}

// A fixed-width slot at the row's far right so titles align whether or not a
// row has a status. The label stays in the accessibility tree as the live region.
// A task's icon also names its status on hover and long-press.
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
          {isTaskStatus(status) ? (
            <StatusGlyphWithLabel status={status} />
          ) : (
            <StatusGlyph icon={status.icon} />
          )}
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
              {/* A task's status stays in place on hover, so its label is still one hover away. */}
              {props.status !== null && isTaskStatus(props.status) ? (
                <span
                  className={cn(
                    "ml-0.5 inline-flex size-4 shrink-0 items-center justify-center self-center",
                    props.status.className,
                  )}
                >
                  <StatusGlyphWithLabel status={props.status} />
                </span>
              ) : null}
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
