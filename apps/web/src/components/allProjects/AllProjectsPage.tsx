import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useDirectorInbox } from "~/state/director";
import { useProjects } from "~/state/entities";
import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { splitDirectorEntry } from "~/state/projectTeam.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { buildTaskRelationsIndex } from "../task/taskRelations.logic";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { DirectorCard } from "../director/DirectorCard";
import { DirectorInbox } from "../director/DirectorInbox";
import { useDirectorChat } from "../director/useDirectorChat";
import {
  buildMapArrows,
  buildProjectMap,
  type MapArrow,
  type MapProject,
  projectKey,
} from "./allProjects.logic";
import { ProjectMapArrows } from "./ProjectMapArrows";
import { type MapWaitingLine, ProjectMapCard } from "./ProjectMapCard";

/**
 * Every project at a glance: one card per project with its direction, checks
 * passed, goals and what waits on the user, and arrows where projects wait on
 * each other. The task lists live in the sidebar.
 */
export function AllProjectsPage() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const { projects: projectEntries } = splitDirectorEntry(entries);
  const director = useDirectorChat();
  const projectInfos = useProjects();
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const mapRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("sm");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const map = buildProjectMap(projectEntries, Date.parse(`${nowMinute}:00.000Z`));
  // The Director's epics are parents of project tasks, so relations span both.
  const arrows = buildMapArrows(map, buildTaskRelationsIndex(entries));
  const { total: needsYouTotal } = useDirectorInbox();
  const keyOf = (project: MapProject) =>
    projectKey(project.environmentId, project.summary.projectId);
  // Hover only matters while arrows show, and only for a card still on the map.
  const focusKey =
    wide && hoveredKey !== null && map.some((project) => keyOf(project) === hoveredKey)
      ? hoveredKey
      : null;

  const infoOf = (project: MapProject) =>
    projectInfos.find(
      (candidate) =>
        candidate.environmentId === project.environmentId &&
        candidate.id === project.summary.projectId,
    ) ?? null;
  const openChat = (environmentId: EnvironmentId, threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  const waitingLines = (project: MapProject): MapWaitingLine[] =>
    arrows
      .filter(
        (arrow) =>
          arrow.from.environmentId === project.environmentId &&
          arrow.from.projectId === project.summary.projectId,
      )
      .map((arrow: MapArrow) => {
        const awaited = map.find(
          (candidate) =>
            candidate.environmentId === arrow.to.environmentId &&
            candidate.summary.projectId === arrow.to.projectId,
        );
        const awaitedTitle =
          awaited === undefined ? "프로젝트" : (infoOf(awaited)?.title ?? "프로젝트");
        return {
          key: `${arrow.from.taskId}->${arrow.to.taskId}`,
          text: `${awaitedTitle} · ${arrow.toGoalTitle} 기다리는 중`,
        };
      });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="min-w-0 flex-1 truncate font-medium text-sm">All projects</h1>
          {needsYouTotal > 0 ? (
            <button
              type="button"
              data-needs-you-total={needsYouTotal}
              onClick={() =>
                document
                  .querySelector("[data-director-inbox]")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className="shrink-0 rounded-full bg-warning/16 px-2.5 py-1 font-medium text-warning text-xs outline-none hover:bg-warning/24 focus-visible:ring-2 focus-visible:ring-ring"
            >
              나를 기다림 {needsYouTotal}
            </button>
          ) : null}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="gap-4 px-3 sm:px-6">
            {director !== null ? <DirectorCard director={director} /> : null}
            <DirectorInbox highlightCardId={null} showEmpty={false} />
            {map.length === 0 ? (
              <p className="text-muted-foreground text-sm">아직 PM이 있는 프로젝트가 없어요.</p>
            ) : (
              <div
                ref={mapRef}
                data-project-map
                className="relative grid grid-cols-1 items-start gap-3 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3"
              >
                {map.map((project) => {
                  const key = keyOf(project);
                  const related =
                    focusKey !== null &&
                    arrows.some((arrow) => {
                      const from = projectKey(arrow.from.environmentId, arrow.from.projectId);
                      const to = projectKey(arrow.to.environmentId, arrow.to.projectId);
                      return (from === focusKey && to === key) || (to === focusKey && from === key);
                    });
                  return (
                    <ProjectMapCard
                      key={key}
                      project={project}
                      info={infoOf(project)}
                      waiting={waitingLines(project)}
                      highlighted={focusKey === key}
                      dimmed={focusKey !== null && focusKey !== key && !related}
                      onHoverChange={(hovered) =>
                        setHoveredKey((current) =>
                          hovered ? key : current === key ? null : current,
                        )
                      }
                      onOpenChat={() => openChat(project.environmentId, project.summary.pmThreadId)}
                    />
                  );
                })}
                <ProjectMapArrows containerRef={mapRef} arrows={arrows} focusKey={focusKey} />
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
