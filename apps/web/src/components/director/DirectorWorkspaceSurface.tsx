import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjects } from "~/state/entities";
import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { splitDirectorEntry } from "~/state/projectTeam.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { buildTaskRelationsIndex } from "../task/taskRelations.logic";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { GoalGraph } from "../goalGraph/GoalGraph";
import {
  buildMapArrows,
  buildProjectMap,
  type MapArrow,
  type MapProject,
  projectKey,
} from "../allProjects/allProjects.logic";
import { ProjectMapArrows } from "../allProjects/ProjectMapArrows";
import { type MapWaitingLine, ProjectMapCard } from "../allProjects/ProjectMapCard";

/**
 * Every project at a glance: one card per project with its direction, checks
 * passed, goals and what waits on the user, and arrows where projects wait on
 * each other. The task lists live in the sidebar.
 */
export function DirectorWorkspaceSurface() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const { projects: projectEntries } = splitDirectorEntry(entries);
  const projectInfos = useProjects();
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const mapRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("sm");
  const [view, setView] = useState<"map" | "graph">("graph");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const map = buildProjectMap(projectEntries, Date.parse(`${nowMinute}:00.000Z`));
  // The Director's epics are parents of project tasks, so relations span both.
  const arrows = buildMapArrows(map, buildTaskRelationsIndex(entries));
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
    <div
      data-testid="director-workspace-surface"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <div className="flex shrink-0 items-center p-3">
          <div className="flex shrink-0 rounded-lg border p-0.5" aria-label="프로젝트 보기">
            {(
              [
                ["graph", "목표 그래프"],
                ["map", "지도"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={`rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === value ? "bg-muted text-foreground" : "text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="gap-4 px-3 sm:px-6">
            {view === "graph" ? (
              <GoalGraph entries={entries} panel />
            ) : map.length === 0 ? (
              <p className="text-muted-foreground text-sm">아직 PM이 있는 프로젝트가 없어요.</p>
            ) : (
              <div
                ref={mapRef}
                data-project-map
                className="relative grid grid-cols-1 items-start gap-3 @md:grid-cols-2 @md:gap-6 @3xl:grid-cols-3"
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
    </div>
  );
}
