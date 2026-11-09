import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjects } from "~/state/entities";
import { taskRouteParams } from "~/taskRoutes";
import { buildThreadRouteParams } from "~/threadRoutes";
import { type MapEntry, projectKey } from "../allProjects/allProjects.logic";
import ChatMarkdown from "../ChatMarkdown";
import { GoalGraphSections } from "./GoalGraphSections";
import { GoalGraphDesktop } from "./GoalGraphDesktop";
import { GoalGraphMobile } from "./GoalGraphMobile";
import { buildGoalGraph, type GoalGraphData } from "./goalGraph.logic";

export type GraphHandle = { focusNode: (id: string) => void };
export type GraphViewProps = {
  graph: GoalGraphData;
  ref: React.Ref<GraphHandle>;
  openChat: (
    project: Pick<GoalGraphData["projects"][number], "environmentId" | "pmThreadId">,
  ) => void;
  openTask: (task: GoalGraphData["tasks"][number]) => void;
};

export function GoalGraph({
  entries,
  panel,
}: {
  entries: ReadonlyArray<MapEntry>;
  panel?: boolean;
}) {
  const projects = useProjects();
  const now = useNowMinute();
  const wide = useMediaQuery("sm");
  const view = useRef<GraphHandle>(null);
  const navigate = useNavigate();
  const [recentOnly, setRecentOnly] = useState(false);
  const graph = useMemo(
    () =>
      buildGoalGraph({
        entries,
        recentOnly,
        projectTitles: new Map(
          projects.map((project) => [projectKey(project.environmentId, project.id), project.title]),
        ),
        nowMs: Date.parse(`${now}:00.000Z`),
      }),
    [entries, projects, now, recentOnly],
  );
  const openChat: GraphViewProps["openChat"] = (project) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(project.environmentId, project.pmThreadId)),
    });
  const openTask: GraphViewProps["openTask"] = (task) =>
    void navigate(taskRouteParams(task.environmentId, task.projectId, task.id));
  if (!panel && !recentOnly && graph.goals.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        아직 목표가 없어요. 디렉터에게 목표를 말해 보세요.
      </p>
    );
  }
  const View = wide && !panel ? GoalGraphDesktop : GoalGraphMobile;
  const director = entries.find((entry) => entry.summary.kind === "director");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {graph.directorBriefing !== null ? (
        <div data-director-briefing className="text-sm">
          <span className="mr-2 text-xs text-muted-foreground">디렉터</span>
          <ChatMarkdown
            cwd={undefined}
            text={graph.directorBriefing}
            environmentId={director?.environmentId}
            threadRef={
              director
                ? scopeThreadRef(director.environmentId, director.summary.pmThreadId)
                : undefined
            }
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="목표 브리핑">
        <button
          type="button"
          aria-pressed={recentOnly}
          className="rounded-full border px-2 py-1 aria-pressed:bg-primary/10"
          onClick={() => setRecentOnly((current) => !current)}
        >
          최근 24시간
        </button>
        {graph.briefing.goals.map((goal) => (
          <button
            type="button"
            className="rounded px-1 py-1 hover:bg-muted"
            key={goal.id}
            onClick={() => view.current?.focusNode(goal.id)}
          >
            {goal.title} {goal.done}/{goal.total}
          </button>
        ))}
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="text-red-500 disabled:text-muted-foreground"
          disabled={graph.briefing.firstBlockedNodeId === null}
          onClick={() => {
            if (graph.briefing.firstBlockedNodeId !== null) {
              view.current?.focusNode(graph.briefing.firstBlockedNodeId);
            }
          }}
        >
          막힌 곳 {graph.briefing.blockedCount}
        </button>
      </div>
      {graph.goals.length === 0 && !recentOnly ? (
        <p className="text-sm text-muted-foreground">
          아직 목표가 없어요. 디렉터에게 목표를 말해 보세요.
        </p>
      ) : recentOnly && graph.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">최근 24시간 안에 바뀐 일이 없어요</p>
      ) : (
        <View ref={view} graph={graph} openChat={openChat} openTask={openTask} />
      )}
      {panel ? <GoalGraphSections graph={graph} /> : null}
    </div>
  );
}
