import { useLocation, useNavigate } from "@tanstack/react-router";
import { LayoutListIcon, MessageSquareIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ALL_PROJECTS_PATH, useNavigateToChat } from "./mainAppLocation";

type RailView = "chat" | "all-projects";

const ENTRIES: ReadonlyArray<{ view: RailView; label: string; icon: LucideIcon }> = [
  { view: "chat", label: "Chat", icon: MessageSquareIcon },
  { view: "all-projects", label: "All projects", icon: LayoutListIcon },
];

/**
 * Switches the main view between Chat and All projects. A thin icon column on
 * the sidebar's left edge on desktop; two tabs at the top of the sheet on phones.
 */
export function WorkspaceRail() {
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const navigateToChat = useNavigateToChat();
  const active: RailView = useLocation({
    select: (location) => (location.pathname === ALL_PROJECTS_PATH ? "all-projects" : "chat"),
  });

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
