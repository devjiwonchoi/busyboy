import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { LayoutListIcon, MessageSquareIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useDirectorInbox } from "~/state/director";
import { type DirectorChat, useDirectorChat } from "../director/useDirectorChat";
import { PmAvatar } from "../PmAvatar";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ALL_PROJECTS_PATH, useNavigateToChat } from "./mainAppLocation";

type RailView = "chat" | "all-projects";

const ENTRIES: ReadonlyArray<{ view: RailView; label: string; icon: LucideIcon }> = [
  { view: "chat", label: "Chat", icon: MessageSquareIcon },
  { view: "all-projects", label: "All projects", icon: LayoutListIcon },
];

/**
 * The workspace Director at the top of the rail: its avatar with a live status
 * dot and a count of questions waiting. Opens the Director's chat.
 */
function DirectorRailButton({
  director,
  compact,
  onOpen,
  className,
  ...rest
}: ComponentProps<"button"> & {
  director: DirectorChat;
  compact: boolean;
  onOpen: () => void;
}) {
  const { persona } = director.entry.summary;
  const { total: waiting } = useDirectorInbox();
  const label = waiting > 0 ? `${persona.name}, 기다리는 일 ${waiting}개` : persona.name;
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      aria-current={director.isOpen ? "page" : undefined}
      data-director-rail
      onClick={onOpen}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-9 w-10" : "size-9",
        director.isOpen ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        className,
      )}
    >
      <PmAvatar persona={persona} status={director.status} size="md" />
      {waiting > 0 ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-warning px-1 text-center font-semibold text-2xs text-white tabular-nums leading-4 ring-2 ring-sidebar"
        >
          {waiting}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Switches the main view between Chat and All projects. A thin icon column on
 * the sidebar's left edge on desktop; two tabs at the top of the sheet on phones.
 */
export function WorkspaceRail() {
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const navigateToChat = useNavigateToChat();
  const director = useDirectorChat();
  const location: RailView = useLocation({
    select: (location) => (location.pathname === ALL_PROJECTS_PATH ? "all-projects" : "chat"),
  });
  // On the Director's chat neither view is current: its avatar is.
  const active: RailView | null = director?.isOpen ? null : location;
  const openDirector = () => {
    if (isMobile) setOpenMobile(false);
    if (director !== null && !director.isOpen) void director.open();
  };

  const open = (view: RailView) => {
    if (isMobile) setOpenMobile(false);
    if (view === active) return;
    if (view === "chat") void navigateToChat();
    else void navigate({ to: ALL_PROJECTS_PATH });
  };

  if (isMobile) {
    return (
      <nav
        aria-label="Views"
        data-workspace-rail="tabs"
        className="flex shrink-0 gap-1 border-b border-sidebar-border px-2 pb-2"
      >
        {director !== null ? (
          <DirectorRailButton director={director} compact onOpen={openDirector} />
        ) : null}
        {ENTRIES.map((entry) => (
          <button
            key={entry.view}
            type="button"
            aria-current={entry.view === active ? "page" : undefined}
            onClick={() => open(entry.view)}
            className={cn(
              "flex h-9 flex-1 items-center justify-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              entry.view === active
                ? "bg-sidebar-row-active text-sidebar-foreground"
                : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
            )}
          >
            <entry.icon aria-hidden className="size-4" />
            {entry.label}
          </button>
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Views"
      data-workspace-rail="column"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border pt-1"
    >
      {director !== null ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <DirectorRailButton director={director} compact={false} onOpen={openDirector} />
              }
            />
            <TooltipPopup side="right">{director.entry.summary.persona.name}</TooltipPopup>
          </Tooltip>
          <span aria-hidden className="my-0.5 h-px w-6 bg-sidebar-border" />
        </>
      ) : null}
      {ENTRIES.map((entry) => (
        <Tooltip key={entry.view}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={entry.label}
                aria-current={entry.view === active ? "page" : undefined}
                onClick={() => open(entry.view)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  entry.view === active
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                )}
              />
            }
          >
            <entry.icon aria-hidden className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="right">{entry.label}</TooltipPopup>
        </Tooltip>
      ))}
    </nav>
  );
}
