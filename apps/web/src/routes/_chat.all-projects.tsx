import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useEnvironmentIds } from "../state/environments";
import { useProjectManagerEntries } from "../state/projectTeam";
import { splitDirectorEntry } from "../state/projectTeam.logic";
import { buildThreadRouteParams } from "../threadRoutes";

/** The old All projects page now lives in the Director's chat. */
function AllProjectsRedirect() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const { director } = splitDirectorEntry(entries);
  const navigate = useNavigate();
  const threadRef =
    director === null ? null : scopeThreadRef(director.environmentId, director.summary.pmThreadId);
  useEffect(() => {
    if (threadRef === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
    });
  }, [navigate, threadRef?.environmentId, threadRef?.threadId]);
  if (threadRef !== null) return null;
  // Until a Director shows up there is nothing to redirect to; never guess "none" from loading state.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
      <p>디렉터를 찾는 중이에요. 전체 프로젝트는 이제 디렉터 화면에 있어요.</p>
      <Link to="/" replace className="text-foreground underline underline-offset-2">
        홈으로
      </Link>
    </div>
  );
}

export const Route = createFileRoute("/_chat/all-projects")({ component: AllProjectsRedirect });
