import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type ProjectTeamAttentionSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { MessageSquarePlusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useId, type MouseEvent as ReactMouseEvent } from "react";

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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
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

/** The second line of a manager row: the PM chat's latest message, or a hint before the first one. */
export function projectManagerPreview(summary: ProjectTeamAttentionSummary): string {
  const last = summary.lastMessage;
  if (last === null) return "No messages yet";
  return last.role === "user" ? `You: ${last.text}` : last.text;
}

/**
 * A project's section heading while its manager is on, shaped like a chat list
 * row: a large PM avatar, the PM and project names, and a one-line preview of
 * the PM chat's latest message.
 *
 * The whole row, avatar included, is one button. From anywhere else it opens
 * the PM chat and unfolds the section; on the PM chat it folds and unfolds.
 * The row's own buttons sit at the end of the name line so they never cover
 * the preview.
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
  jumpLabel?: string | null;
}) {
  const { summary, pmThreadRef, projectName } = props;
  const canOperate = useEnvironmentScope(pmThreadRef.environmentId, AuthOrchestrationOperateScope);
  const nowMinute = useNowMinute();
  const presence = formatProjectManagerPresence(summary, Date.parse(`${nowMinute}:00.000Z`));
  const status = resolveProjectManagerStatus({ summary, pmThreadWorking: props.pmThreadWorking });
  const preview = props.pmThreadWorking ? "Working…" : projectManagerPreview(summary);
  const nameId = useId();
  const previewId = useId();
  const handleClick = () => {
    if (props.isActive) {
      props.onToggle();
      return;
    }
    props.onOpenThread(pmThreadRef);
    if (!props.expanded) props.onToggle();
  };
  return (
    <div className="group/project">
      <div
        data-testid="sidebar-project-manager-heading"
        className={cn(
          "relative flex min-h-12 items-center gap-2 rounded-lg py-1 pr-1 pl-1.5 transition-colors",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="sidebar-project-manager-toggle"
                aria-labelledby={`${nameId} ${previewId}`}
                aria-expanded={props.expanded}
                aria-current={props.isActive ? "page" : undefined}
                onClick={handleClick}
                className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            }
          />
          <TooltipPopup side="right">{presence}</TooltipPopup>
        </Tooltip>
        <span className="pointer-events-none shrink-0">
          <PmAvatar persona={summary.persona} status={status} size="lg" />
        </span>
        <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
          <span className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
            <span id={nameId} className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="min-w-0 shrink-0 truncate font-semibold text-sidebar-foreground">
                {summary.persona.name}
              </span>
              <span className="min-w-0 truncate text-2xs text-sidebar-muted-foreground">
                {projectName}
              </span>
            </span>
            <SidebarProjectManagerBadges summary={summary} />
            <span
              data-testid="sidebar-project-manager-actions"
              className="pointer-events-auto relative flex shrink-0 items-center"
            >
              {props.onNewThread ? (
                <SidebarProjectAddMenu projectName={projectName} onNewThread={props.onNewThread} />
              ) : null}
              {/* Always visible: touch screens cannot hover to reveal it. */}
              {canOperate ? (
                <SidebarSitrepButton
                  threadRef={pmThreadRef}
                  summary={summary}
                  onThreadActivate={props.onOpenThread}
                />
              ) : null}
            </span>
          </span>
          <span
            id={previewId}
            data-testid="sidebar-project-manager-preview"
            className={cn(
              "block min-w-0 truncate text-xs",
              summary.lastMessage === null && !props.pmThreadWorking
                ? "text-sidebar-muted-foreground/70"
                : "text-sidebar-muted-foreground",
            )}
          >
            {preview}
          </span>
        </span>
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </div>
    </div>
  );
}

/**
 * One "+" for everything a project can add, so the row never shows two
 * look-alike add icons. Hover-only with a mouse; always shown on touch screens
 * and at phone width, where the sidebar is a sheet.
 */
function SidebarProjectAddMenu(props: { projectName: string; onNewThread: () => void }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Add to ${props.projectName}`}
        className={cn(
          "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 data-popup-open:opacity-100",
          "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/project:opacity-100 group-focus-within/project:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100",
        )}
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={props.onNewThread}>
          <MessageSquarePlusIcon aria-hidden />
          New thread
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
