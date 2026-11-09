import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatTaskKey } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useNowMinute } from "~/hooks/useNowMinute";
import { taskRouteParams } from "~/taskRoutes";
import { buildThreadRouteParams } from "~/threadRoutes";
import { AttentionContext } from "../chat/AttentionContext";
import { decisionQuestionPresentation } from "../chat/DecisionCard.logic";
import { InboxTaskLink, useDirectorInboxTitles } from "../director/DirectorInbox";
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

function RunningTask({ task }: { task: GoalGraphData["tasks"][number] }) {
  return (
    <li className="py-1.5 text-xs">
      <Link {...taskRouteParams(task.environmentId, task.projectId, task.id)} className={linkClass}>
        {task.key} {task.title}
      </Link>
      <p className={task.stalled ? "mt-1 text-warning" : "mt-1 text-muted-foreground"}>
        {task.stalled ? "멈춤" : task.stage === "in_review" ? "검토 중" : "진행 중"}
        {task.live ? " · 에이전트 작업 중" : ""}
      </p>
    </li>
  );
}
export function GoalGraphSections({
  graph,
  openCard,
}: {
  graph: GoalGraphData;
  openCard: (id: string) => void;
}) {
  const titles = useDirectorInboxTitles();
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const navigate = useNavigate();
  return (
    <div>
      <section aria-label="내 할 일">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-semibold">내 할 일 {graph.attention.total}</h2>
          <span className="text-muted-foreground text-xs">오래된 순</span>
        </div>
        {graph.attention.total === 0 ? (
          <p className="py-4 text-muted-foreground text-xs">기다리는 일이 없어요</p>
        ) : null}
        <ol className="divide-y divide-border">
          {graph.attention.cards.map(({ group, card }) => {
            const hours = Math.max(
              0,
              Math.floor((now - Date.parse(card.item.createdAt)) / 3_600_000),
            );
            const elapsed =
              hours === 0
                ? "1시간 이내"
                : hours < 24
                  ? `${hours}시간째 기다림`
                  : `${Math.floor(hours / 24)}일째 기다림`;
            const kind = {
              approval: "승인",
              decision: "질문·결정",
              blocker: "막힘",
              proposal: "제안",
            }[card.item.kind];
            return (
              <li
                key={`${group.environmentId}:${card.item.id}`}
                data-workspace-attention={card.item.id}
                className="py-3"
              >
                <p className="break-words text-muted-foreground text-xs">
                  {titles(group)} ·{" "}
                  {card.taskNumber > 0 ? formatTaskKey(group.taskKeyPrefix, card.taskNumber) : ""}{" "}
                  <InboxTaskLink card={card} group={group} />
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {kind} · {elapsed}
                </p>
                <p className="mt-2 line-clamp-2 break-words">
                  {
                    decisionQuestionPresentation({
                      question: card.item.question,
                      action: card.item.context?.action,
                      taskTitle: card.taskTitle,
                    }).headline
                  }
                </p>
                {card.item.context ? (
                  <div className="mt-2">
                    <AttentionContext
                      context={card.item.context}
                      planApproval={card.item.kind === "approval"}
                    />
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  {card.item.context == null ? (
                    <span className="text-muted-foreground text-xs">
                      {card.item.kind === "blocker" ? (
                        <span className="text-warning">직접 확인 필요 · </span>
                      ) : null}
                      위험 정보 미제공
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`${titles(group)} ${card.taskTitle} 카드 열기`}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => openCard(card.item.id)}
                  >
                    카드 열기
                  </button>
                </div>
              </li>
            );
          })}
          {graph.attention.waiting.map(({ group, thread }) => (
            <li key={`${group.environmentId}:${thread.threadId}`} className="py-3">
              <p className="break-words text-muted-foreground text-xs">
                {titles(group)} ·{" "}
                {{ question: "스레드 질문", approval: "도구 승인", plan: "계획 승인" }[thread.kind]}
              </p>
              <button
                type="button"
                className={`${linkClass} mt-1`}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(group.environmentId, thread.threadId),
                    ),
                  })
                }
              >
                {thread.title} · 채팅 열기
              </button>
            </li>
          ))}
        </ol>
      </section>
      <details open className="mt-5 border-t pt-3">
        <summary className="cursor-pointer font-medium">
          진행 중 {graph.runningProjects.reduce((sum, project) => sum + project.tasks.length, 0)}
        </summary>
        {graph.runningProjects.length === 0 ? (
          <p className="mt-3 text-muted-foreground text-xs">진행 중인 태스크가 없어요</p>
        ) : null}
        {graph.runningProjects.map((entry) => (
          <div key={`${entry.environmentId}:${entry.summary.projectId}`} className="mt-3">
            <h3 className="text-muted-foreground text-xs">{entry.title}</h3>
            <ul>
              {entry.tasks.map((task) => (
                <RunningTask key={task.id} task={task} />
              ))}
            </ul>
          </div>
        ))}
      </details>
      <details open className="mt-5 border-t pt-3">
        <summary className="cursor-pointer font-medium">에픽 진행률</summary>
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
      </details>
      <details className="mt-5 border-t pt-3">
        <summary className="cursor-pointer font-medium">마감</summary>
        <p className="mt-3 text-muted-foreground text-xs">
          현재 태스크에 마감 필드가 없어요. 선택적 마감일을 추가하면 이번 주·다음 주로 모아 볼 수
          있어요.
        </p>
      </details>
    </div>
  );
}
