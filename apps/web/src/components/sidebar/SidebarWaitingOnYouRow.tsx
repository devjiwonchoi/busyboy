import { useRouter, useRouterState } from "@tanstack/react-router";
import { HandIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { countWaitingOnYou } from "../inbox/WaitingOnYouPage";

/**
 * The sidebar's way into "Waiting on you": every task question and plan
 * approval across projects. Hidden while nothing waits, unless that page is open.
 */
export function SidebarWaitingOnYouRow(props: { onNavigate?: () => void }) {
  const router = useRouter();
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const isActive = useRouterState({ select: (state) => state.location.pathname === "/inbox" });
  const count = countWaitingOnYou(entries.map((entry) => entry.summary));
  if (count === 0 && !isActive) return null;
  return (
    <li className="list-none py-px">
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        onClick={() => {
          props.onNavigate?.();
          void router.navigate({ to: "/inbox" });
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <HandIcon aria-hidden className="size-3.5 text-warning" />
        <span className="min-w-0 flex-1 truncate">Waiting on you</span>
        {count > 0 ? (
          <span
            aria-label={`${count} waiting`}
            className="rounded-full bg-warning/16 px-1.5 font-semibold text-2xs text-warning tabular-nums leading-4"
          >
            {count}
          </span>
        ) : null}
      </button>
    </li>
  );
}
