import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type SidebarRowStatusIcon = "working" | "waiting" | "input" | "approval" | "failed" | "done";

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

const statusIconClassName = "size-4 shrink-0";

function StatusGlyph(props: { icon: SidebarRowStatusIcon }) {
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
// clusters at the right. Hover/keyboard focus swaps the passive indicators for
// the row actions, which sit just left of the status icon.
export function SidebarRowLine(props: {
  title: ReactNode;
  status: SidebarRowStatus | null;
  indicators?: ReactNode;
  actions?: ReactNode;
  // Replaces the whole right cluster, e.g. the drop destination while dragging.
  trailingOverride?: ReactNode;
}) {
  const hasActions = props.actions != null && props.actions !== false;
  return (
    <div className="relative z-10 flex h-8 min-w-0 items-center gap-1.5 px-(--sidebar-row-content-inset)">
      <div className="flex min-w-0 flex-1 items-center">{props.title}</div>
      {props.trailingOverride != null ? (
        props.trailingOverride
      ) : (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="group/sidebar-row-actions relative flex h-5 shrink-0 items-stretch justify-end">
            {props.indicators != null ? (
              <span
                className={cn(
                  "pointer-events-none flex items-center gap-1.5 transition-opacity",
                  hasActions &&
                    "group-has-[:focus-visible]/sidebar-row-actions:absolute group-has-[:focus-visible]/sidebar-row-actions:right-0 group-has-[:focus-visible]/sidebar-row-actions:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                )}
              >
                {props.indicators}
              </span>
            ) : null}
            {hasActions ? (
              // focus-visible, not focus-within: a mouse click leaves the clicked
              // button focused, and focus-within would keep the actions shown
              // after the pointer leaves.
              <span
                data-testid="sidebar-row-actions"
                className="pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100"
              >
                {props.actions}
              </span>
            ) : null}
          </span>
          <SidebarRowStatusSlot status={props.status} />
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
