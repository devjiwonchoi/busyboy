import { formatTaskKey } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { taskRouteParams } from "~/taskRoutes";
import { blockedByLabel, type RelatedTask } from "../task/taskRelations.logic";
import { GOAL_GRAPH_STATUS_LABELS, type GoalGraphData } from "./goalGraph.logic";

const linkClass =
  "break-words text-left hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

function Dependencies({ tasks }: { tasks: readonly RelatedTask[] }) {
  if (tasks.length === 0) {
    return null;
  }
  return <p className="mt-1 break-words text-warning text-xs">{blockedByLabel(tasks)}</p>;
}

/** Each open Director epic: done / total, a status bar, and what its subtasks wait on. */
export function GoalGraphSections({ graph }: { graph: GoalGraphData }) {
  return (
    <section aria-label="에픽 진행도" className="border-t pt-3">
      <h2 className="font-medium">에픽 진행도</h2>
      {graph.epics.length === 0 ? (
        <p className="mt-3 text-muted-foreground text-xs">진행 중인 에픽이 없어요</p>
      ) : null}
      {graph.epics.map((epic) => (
        <div key={`${epic.environmentId}:${epic.task.id}`} className="mt-3 text-xs">
          <Link
            {...taskRouteParams(epic.environmentId, epic.summary.projectId, epic.task.id)}
            className={linkClass}
          >
            {formatTaskKey(epic.summary.taskKeyPrefix, epic.task.number)} {epic.task.title}
          </Link>
          {epic.progress ? (
            <>
              <p className="mt-2">
                완료 {epic.progress.done} / {epic.progress.total}
              </p>
              <div
                role="img"
                aria-label={epic.counts
                  .map(([status, count]) => `${GOAL_GRAPH_STATUS_LABELS[status]} ${count}`)
                  .join(" · ")}
                className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted"
              >
                {epic.counts.map(([status, count]) => (
                  <span
                    key={status}
                    style={{ width: `${(100 * count) / epic.progress!.total}%` }}
                    className={
                      status === "done"
                        ? "bg-success"
                        : status === "in_progress" || status === "in_review" || status === "ready"
                          ? "bg-primary"
                          : "bg-warning"
                    }
                  />
                ))}
              </div>
              <p className="mt-1 text-muted-foreground">
                {epic.counts
                  .map(([status, count]) => `${GOAL_GRAPH_STATUS_LABELS[status]} ${count}`)
                  .join(" · ")}
              </p>
            </>
          ) : (
            <p className="mt-2 text-muted-foreground">하위 태스크가 없어요</p>
          )}
          {epic.cancelled > 0 ? (
            <p className="mt-1 text-muted-foreground">취소 {epic.cancelled}개 (완료율 제외)</p>
          ) : null}
          <Dependencies tasks={epic.blockedBy} />
          {epic.children
            .filter((child) => child.blockedBy.length > 0)
            .map((child) => (
              <div key={child.task.id} className="mt-2">
                <Link
                  {...taskRouteParams(child.environmentId, child.projectId, child.task.id)}
                  className={linkClass}
                >
                  {child.key} {child.task.title}
                </Link>
                <Dependencies tasks={child.blockedBy} />
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}
