import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjects } from "~/state/entities";
import { taskRouteParams } from "~/taskRoutes";
import { buildThreadRouteParams } from "~/threadRoutes";
import { type MapEntry, projectKey } from "../allProjects/allProjects.logic";
import { DirectorInbox } from "../director/DirectorInbox";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../ui/dialog";
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
  /** "나를 기다림": the waiting card itself, or the PM chat when there is none. */
  openWaiting: (
    node: Pick<GoalGraphData["tasks"][number], "environmentId" | "pmThreadId" | "cardId">,
  ) => void;
};

export function GoalGraph({ entries }: { entries: ReadonlyArray<MapEntry> }) {
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
  const [cardId, setCardId] = useState<string | null>(null);
  const openWaiting: GraphViewProps["openWaiting"] = (node) =>
    node.cardId === null ? openChat(node) : setCardId(node.cardId);
  const openTask: GraphViewProps["openTask"] = (task) =>
    void navigate(taskRouteParams(task.environmentId, task.projectId, task.id));
  if (!recentOnly && graph.goals.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        아직 목표가 없어요. 디렉터에게 목표를 말해 보세요.
      </p>
    );
  }
  const View = wide ? GoalGraphDesktop : GoalGraphMobile;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {graph.directorBriefing !== null ? (
        <p data-director-briefing className="text-sm">
          <span className="mr-2 text-xs text-muted-foreground">디렉터</span>
          {graph.directorBriefing}
        </p>
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
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="text-warning disabled:text-muted-foreground"
          disabled={graph.briefing.firstNeedsYouNodeId === null}
          onClick={() => {
            if (graph.briefing.firstNeedsYouNodeId !== null) {
              view.current?.focusNode(graph.briefing.firstNeedsYouNodeId);
            }
          }}
        >
          나를 기다림 {graph.briefing.needsYouCount}
        </button>
      </div>
      {recentOnly && graph.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">최근 24시간 안에 바뀐 일이 없어요</p>
      ) : (
        <View
          ref={view}
          graph={graph}
          openChat={openChat}
          openTask={openTask}
          openWaiting={openWaiting}
        />
      )}
      <Dialog
        open={cardId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCardId(null);
          }
        }}
      >
        <DialogPopup
          showCloseButton={false}
          className="flex max-h-[85dvh] w-full min-w-0 flex-col overflow-y-auto p-4 sm:max-w-3xl"
        >
          <div className="mb-4 flex items-center gap-2">
            <DialogTitle className="flex-1">나를 기다리는 일</DialogTitle>
            <DialogClose className="rounded-md px-3 py-2 text-sm hover:bg-muted">닫기</DialogClose>
          </div>
          <DirectorInbox highlightCardId={cardId} showEmpty />
        </DialogPopup>
      </Dialog>
    </div>
  );
}
