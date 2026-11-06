import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type ProjectTeamAttentionSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ListPlusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../hooks/useNowMinute";
import { useRequestSitrep } from "../state/projectTeam";
import {
  formatProjectManagerPresence,
  resolveProjectManagerStatus,
} from "../state/projectTeam.logic";
import { useEnvironmentScope } from "../state/session";
import { PmAvatar } from "./PmAvatar";
import { JumpHintBadge } from "./sidebar/JumpHintBadge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SidebarProjectManagerBadges(props: { summary: ProjectTeamAttentionSummary }) {
  const { openCount, unreadSitrepCount } = props.summary;
  if (openCount === 0 && unreadSitrepCount === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {openCount > 0 ? (
        <span
          role="status"
          aria-label={`Needs you: ${openCount}`}
          className="rounded-full bg-warning/16 px-1.5 font-semibold text-2xs text-warning tabular-nums leading-4"
        >
          {openCount}
        </span>
      ) : null}
      {unreadSitrepCount > 0 ? (
        <span role="img" aria-label="Unread sitrep" className="size-1.5 rounded-full bg-info" />
      ) : null}
    </span>
  );
}

export function SidebarSitrepButton(props: {
  threadRef: ScopedThreadRef;
  summary: ProjectTeamAttentionSummary;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const requestSitrep = useRequestSitrep();
  const handleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void requestSitrep(scopeProjectRef(props.threadRef.environmentId, props.summary.projectId));
    props.onThreadActivate(props.threadRef);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Sitrep"
            disabled={props.summary.sitrepInProgress}
            onClick={handleClick}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-default disabled:opacity-64"
          />
        }
      >
        <RefreshCwIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.summary.sitrepInProgress ? "Sitrep in progress" : "Sitrep now"}
      </TooltipPopup>
    </Tooltip>
  );
}

const hoverOnlyClassName =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/project:opacity-100 group-focus-within/project:opacity-100";

/**
 * A project's section heading while its manager is on: the PM avatar and name
 * stand for the project. Clicking the row folds the section like a project
 * folder; clicking the avatar opens the PM thread.
 */
export function SidebarProjectManagerHeading(props: {
  projectName: string;
  summary: ProjectTeamAttentionSummary;
  pmThreadRef: ScopedThreadRef;
  pmThreadWorking: boolean;
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onNewThread: (() => void) | null;
  /** Opens the new task composer for this project. */
  onNewTask?: (() => void) | null;
  jumpLabel?: string | null;
}) {
  const { summary, pmThreadRef, projectName } = props;
  const canOperate = useEnvironmentScope(pmThreadRef.environmentId, AuthOrchestrationOperateScope);
  const nowMinute = useNowMinute();
  const presence = formatProjectManagerPresence(summary, Date.parse(`${nowMinute}:00.000Z`));
  const status = resolveProjectManagerStatus({ summary, pmThreadWorking: props.pmThreadWorking });
  return (
    <div className="group/project">
      <div
        data-testid="sidebar-project-manager-heading"
        className={cn(
          "relative flex h-7 items-center rounded-md transition-colors",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open ${summary.persona.name} chat`}
                aria-current={props.isActive ? "page" : undefined}
                onClick={() => props.onOpenThread(pmThreadRef)}
                className="ml-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              />
            }
          >
            <PmAvatar persona={summary.persona} status={status} size="sm" />
          </TooltipTrigger>
          <TooltipPopup side="right">Open PM chat</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-expanded={props.expanded}
                onClick={props.onToggle}
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            }
          >
            <span className="min-w-0 truncate font-semibold text-sidebar-foreground">
              {projectName}
            </span>
            <span className="min-w-0 truncate text-sidebar-muted-foreground">
              {summary.persona.name}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="right">{presence}</TooltipPopup>
        </Tooltip>
        <SidebarProjectManagerBadges summary={summary} />
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        <span
          className={cn(
            "flex shrink-0 items-center",
            "pointer-events-none group-hover/project:pointer-events-auto group-focus-within/project:pointer-events-auto",
            hoverOnlyClassName,
          )}
        >
          {canOperate && props.onNewTask ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New task in ${projectName}`}
                    onClick={props.onNewTask}
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                  />
                }
              >
                <ListPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">New task</TooltipPopup>
            </Tooltip>
          ) : null}
          {props.onNewThread ? (
            <button
              type="button"
              aria-label={`New thread in ${projectName}`}
              onClick={props.onNewThread}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
        {/* Always visible: touch screens cannot hover to reveal it. */}
        {canOperate ? (
          <SidebarSitrepButton
            threadRef={pmThreadRef}
            summary={summary}
            onThreadActivate={props.onOpenThread}
          />
        ) : null}
      </div>
    </div>
  );
}
