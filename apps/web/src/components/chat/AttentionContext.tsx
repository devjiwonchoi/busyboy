import type {
  EnvironmentId,
  ProjectAttentionContext,
  ProjectDecisionCard,
} from "@t3tools/contracts";
import {
  requestImpactLabels,
  requestSenderLabel,
  shortWorkName,
} from "@t3tools/shared/requestMessage";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useProjects } from "~/state/entities";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { taskRouteParams } from "~/taskRoutes";
import { useRelatedTask } from "../task/TaskRelations";

/** Resolve the task's own project, which can differ from the Director card's project. */
export function useAttentionTask({
  card,
  environmentId,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
}) {
  const related = useRelatedTask(environmentId, card.item.taskId);
  const projects = useProjects();
  const managers = useProjectManagerEntries([environmentId]);
  const isDirector = managers.some(
    (entry) => entry.summary.projectId === card.item.projectId && entry.summary.kind === "director",
  );
  const projectId = related?.projectId ?? card.item.projectId;
  const projectTitle =
    isDirector && related === null
      ? "프로젝트 확인 필요"
      : (projects.find(
          (project) => project.environmentId === environmentId && project.id === projectId,
        )?.title ?? "프로젝트 확인 필요");

  return { related, projectId, projectTitle };
}

/** Sender identity is shared by requests and waiting lists, including legacy cards. */
export function useRequestSender(card: ProjectDecisionCard, environmentId: EnvironmentId) {
  const { related, projectTitle } = useAttentionTask({ card, environmentId });
  return (
    requestSenderLabel({
      role: card.item.senderRole ?? (related?.task.leadThreadId ? "lead" : "pm"),
      name: card.item.senderName ?? shortWorkName(card.taskTitle),
      projectTitle,
    }) ?? projectTitle
  );
}

/** Task names in cards use the same stable task page even before a lead thread exists. */
export function AttentionTaskLink({
  card,
  environmentId,
  children,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  children: ReactNode | undefined;
}) {
  const { related, projectTitle } = useAttentionTask({ card, environmentId });
  const router = useRouter({ warn: false });
  const label = `${card.taskTitle} · ${projectTitle}${related === null ? "" : ` (${related.key})`}`;
  if (router == null || related === null) {
    return <>{children ?? label}</>;
  }

  return (
    <Link
      {...taskRouteParams(environmentId, related.projectId, related.task.id)}
      data-attention-task-link
      className="min-w-0 text-foreground underline decoration-border underline-offset-2 hover:decoration-current"
    >
      {children ?? label}
    </Link>
  );
}

/** The same approval facts in the PM chat, plan review, and Director inbox. */
export function AttentionContext({
  context,
  planApproval,
}: {
  context: ProjectAttentionContext | null | undefined;
  planApproval: boolean;
}) {
  if (context == null) {
    return (
      <p data-attention-context="unknown" className="text-warning-foreground text-xs">
        영향 확인 필요: 이 요청에는 구조화된 이유·영향·추천안 정보가 없습니다.
      </p>
    );
  }

  const impacts = requestImpactLabels(context);

  return (
    <section
      data-attention-context="known"
      aria-label="요청 내용과 영향"
      className="space-y-2 text-sm"
    >
      <dl className="space-y-2">
        <div>
          <dt className="text-muted-foreground text-xs">무엇을 하나요</dt>
          <dd data-attention-action className="wrap-break-word font-medium">
            {context.action}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">왜 필요한가요</dt>
          <dd data-attention-reason className="whitespace-pre-wrap wrap-break-word">
            {context.reason}
          </dd>
        </div>
      </dl>
      <div data-attention-impacts className="flex flex-wrap gap-1">
        {impacts.map((impact) => (
          <span key={impact} className="rounded-full border border-border px-2 py-0.5 text-xs">
            {impact}
          </span>
        ))}
      </div>
      <div>
        <p className="text-muted-foreground text-xs">추천안</p>
        <p data-attention-recommendation className="whitespace-pre-wrap wrap-break-word">
          {context.recommendation}
        </p>
      </div>
      {planApproval ? (
        <p data-attention-approval-scope className="text-muted-foreground text-xs">
          계획 승인입니다. 머지·배포·비용·외부 게시 실행은 해당 작업의 승인을 따로 확인해야 합니다.
        </p>
      ) : null}
    </section>
  );
}
