import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectTeamAttentionSummary, ScopedThreadRef } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useRequestSitrep } from "../state/projectTeam";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SidebarProjectManagerBadges(props: { summary: ProjectTeamAttentionSummary }) {
  const { openCount, unreadSitrepCount } = props.summary;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className="rounded-sm border border-sidebar-border px-1 font-medium text-2xs text-muted-foreground leading-4">
        PM
      </span>
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
            className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-64"
          />
        }
      >
        <RefreshCwIcon aria-hidden className="size-3" />
        Sitrep
      </TooltipTrigger>
      <TooltipPopup side="top">Sitrep now</TooltipPopup>
    </Tooltip>
  );
}
