import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import { useThreadShell } from "~/state/entities";
import { useEnvironmentIds } from "~/state/environments";
import { useDirector } from "~/state/director";
import type { ProjectManagerEntry } from "~/state/projectTeam";
import { type ProjectManagerStatus, resolveProjectManagerStatus } from "~/state/projectTeam.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export interface DirectorChat {
  readonly entry: ProjectManagerEntry;
  readonly threadRef: ScopedThreadRef;
  /** Null until the thread list has loaded. */
  readonly thread: EnvironmentThreadShell | null;
  readonly status: ProjectManagerStatus;
  readonly working: boolean;
  /** True while the Director's chat is the open page. */
  readonly isOpen: boolean;
  readonly open: () => Promise<void>;
}

/** The workspace Director's chat, or null before the server has made one. */
export function useDirectorChat(): DirectorChat | null {
  const entry = useDirector(useEnvironmentIds());
  const threadRef =
    entry === null ? null : scopeThreadRef(entry.environmentId, entry.summary.pmThreadId);
  const thread = useThreadShell(threadRef);
  // Matched on the path: route params update a render after the location.
  const pathname = useLocation({ select: (location) => location.pathname });
  const router = useRouter();
  const navigate = useNavigate();
  if (entry === null || threadRef === null) return null;
  const chatPath = router.buildLocation({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(threadRef),
  }).pathname;
  const working = thread !== null && resolveSidebarThreadStatus(thread) === "working";
  return {
    entry,
    threadRef,
    thread,
    working,
    status: resolveProjectManagerStatus({ summary: entry.summary, pmThreadWorking: working }),
    isOpen: pathname === chatPath,
    open: () =>
      navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) }),
  };
}
