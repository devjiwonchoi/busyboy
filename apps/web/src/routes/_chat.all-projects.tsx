import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildGoalMap } from "@t3tools/shared/goalMap";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { GoalMap } from "../components/goalMap/GoalMap";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEnvironmentIds } from "../state/environments";
import { useProjectManagerEntries } from "../state/projectTeam";

/** Every active workspace goal with its open work, opened from the rail. */
function AllProjectsPage() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const map = useMemo(() => buildGoalMap({ entries }), [entries]);
  const director = map.director;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div
        data-all-projects
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
      >
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="min-w-0 flex-1 truncate font-medium text-sm">전체 프로젝트</h1>
        </WorkspacePageHeader>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-6">
          {map.briefing !== null && director !== null ? (
            <div data-director-briefing className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground text-xs">디렉터</span>
              <ChatMarkdown
                cwd={undefined}
                text={map.briefing}
                className="min-w-0 flex-1"
                environmentId={director.environmentId}
                threadRef={scopeThreadRef(director.environmentId, director.summary.pmThreadId)}
              />
            </div>
          ) : null}
          {director === null ? (
            <p className="text-muted-foreground text-sm">디렉터를 찾는 중이에요.</p>
          ) : map.goals.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              아직 목표가 없어요. 디렉터에게 목표를 말해 보세요.
            </p>
          ) : (
            <GoalMap map={map} />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/all-projects")({ component: AllProjectsPage });
