import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import {
  formatProjectManagerPresence,
  resolveProjectManagerStatus,
} from "../../state/projectTeam.logic";
import { PmAvatar } from "../PmAvatar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The PM thread's breadcrumb item: who the PM is, whose project, and what it is up to. */
export function ProjectManagerHeaderIdentity(props: {
  summary: ProjectTeamAttentionSummary;
  projectName: string | null;
  pmThreadWorking: boolean;
  onOpenSettings: (() => void) | null;
}) {
  const { summary } = props;
  const nowMinute = useNowMinute();
  const presence = formatProjectManagerPresence(summary, Date.parse(`${nowMinute}:00.000Z`));
  const status = resolveProjectManagerStatus({ summary, pmThreadWorking: props.pmThreadWorking });
  const identity = (
    <>
      <PmAvatar persona={summary.persona} status={status} size="md" />
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">
        {summary.persona.name}
      </h2>
    </>
  );
  return (
    <div className="flex min-w-0 items-center gap-2">
      {props.onOpenSettings ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${summary.persona.name} settings`}
                onClick={props.onOpenSettings}
                className="inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            {identity}
          </TooltipTrigger>
          <TooltipPopup side="bottom">Project manager settings</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-2">{identity}</span>
      )}
      <span className="shrink-0 rounded-sm border border-border px-1 text-2xs leading-4 font-medium text-muted-foreground">
        {props.projectName ? `PM · ${props.projectName}` : "PM"}
      </span>
      <span
        data-testid="project-manager-presence"
        className="min-w-0 truncate text-xs text-muted-foreground"
      >
        {presence}
      </span>
    </div>
  );
}
