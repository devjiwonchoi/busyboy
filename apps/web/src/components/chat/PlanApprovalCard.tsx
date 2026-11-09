import {
  type EnvironmentId,
  PLAN_APPROVAL_START,
  planApprovalOutcome,
  type PlanApprovalOutcome,
  type ProjectApprovalPlan,
  type ProjectDecisionCard,
  type ProjectTaskReference,
  type ProjectTaskStage,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { useAnswerDecision, useTaskDetail } from "~/state/projectTeam";

import { PlanTodoList } from "../plan/PlanTodoList";
import { planProgressLabel, type PlanTodoLike } from "../plan/planView.logic";
import { TaskModelSteps } from "../task/TaskModelSteps";
import { LiveTaskPhaseBadge } from "../task/TaskPhaseBadge";
import { TaskStructureLine, useTaskRelations } from "../task/TaskRelations";
import { Button } from "../ui/button";
import { AFK_ANSWERED_LABEL } from "./Afk";
import { PlanApprovalModal } from "./PlanApprovalModal";
import { PlanApprovalSections, PlanSummary, PlanTitle } from "./PlanMarkdown";
import { AttentionContext, AttentionTaskLink, useAttentionTask } from "./AttentionContext";

const OUTCOME_LABEL: Record<PlanApprovalOutcome, string> = {
  start: "Approved and started",
  // Older cards could be approved without starting.
  approve_only: "Approved",
  changes: "Changes requested",
};

/** "Plan approval · Fix login · v3". */
export function planApprovalHeader(card: ProjectDecisionCard): string {
  const version = card.item.specVersion === null ? "" : ` · v${card.item.specVersion}`;
  return `Plan approval · ${card.taskTitle}${version}`;
}

/** A plan from a spec with the summary + todos shape; older plans fall back to Goal/Verification. */
function structuredPlan(card: ProjectDecisionCard): ProjectApprovalPlan | null {
  const plan = card.plan;
  if (plan === null) return null;
  return plan.summary.trim().length > 0 || plan.todos.length > 0 ? plan : null;
}

/** "BU-62 · Plan approval · v3". */
function metaLine(key: string | null, label: string, specVersion: number | null): string {
  return [label, specVersion === null ? null : `v${specVersion}`, key === null ? null : `(${key})`]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * A task lead's plan, waiting for the user's go-ahead: meta line, title, the lead's summary and
 * the steps as a todo list, with Approve (same answer call as the modal, so it counts as the
 * user's click; it always starts the work) and View details for the full plan and comments.
 * Once approved the same card stays as a live progress board: steps tick as the lead checks
 * them off and the current one spins. Changes requested or closed: one muted line.
 */
export function PlanApprovalCard({
  card,
  environmentId,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const answerDecision = useAnswerDecision();
  const relations = useTaskRelations(environmentId, card.item.taskId);
  const { related, projectTitle } = useAttentionTask({ card, environmentId });
  const key = related?.key ?? null;
  const header = `${planApprovalHeader(card)} · ${projectTitle}`;
  const answer = card.item.answer;
  const plan = structuredPlan(card);
  const state =
    card.item.answeredAt !== null
      ? "answered"
      : card.item.supersededAt !== null
        ? "resolved"
        : "open";
  const outcome = state === "answered" ? planApprovalOutcome(answer ?? "") : null;

  const modal = (
    <PlanApprovalModal
      card={card}
      environmentId={environmentId}
      open={reviewing}
      onOpenChange={setReviewing}
      readOnly={state !== "open"}
    />
  );

  const approve = (answer: string) => {
    if (sending) return;
    setSending(true);
    void answerDecision(environmentId, {
      projectId: card.item.projectId,
      attentionItemId: card.item.id,
      answer,
    }).then((result) => {
      // On success the attention stream turns this card into its answered state.
      if (!AsyncResult.isSuccess(result)) setSending(false);
    });
  };

  if (plan !== null && outcome !== null && outcome !== "changes") {
    return (
      <div
        data-decision-card={card.item.id}
        data-decision-card-state="answered"
        data-plan-board
        className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5"
      >
        <AttentionTaskLink card={card} environmentId={environmentId}>
          <PlanTitle
            as="div"
            meta={metaLine(
              key,
              `${OUTCOME_LABEL[outcome]} · ${projectTitle}`,
              card.item.specVersion,
            )}
            title={card.taskTitle}
          />
        </AttentionTaskLink>
        <AttentionContext context={card.item.context} planApproval />
        <PlanSummary text={plan.summary} />
        <LivePlanBoard
          card={card}
          environmentId={environmentId}
          pinned={plan}
          task={related?.task ?? null}
          afk={card.item.answeredBy === "afk"}
          onViewDetails={() => setReviewing(true)}
        />
        {modal}
      </div>
    );
  }

  if (state === "answered") {
    const answered = outcome ?? planApprovalOutcome("");
    const feedback = (answer ?? "").split("\n").slice(1).join("\n").trim();
    return (
      <div
        data-decision-card={card.item.id}
        data-decision-card-state="answered"
        className="rounded-xl border border-border/50 px-3 py-2 text-sm"
      >
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="min-w-0 truncate font-medium text-muted-foreground">{header}</span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span data-plan-outcome={answered}>{OUTCOME_LABEL[answered]}</span>
          {card.item.answeredBy === "afk" ? (
            <span className="text-muted-foreground text-xs">{AFK_ANSWERED_LABEL}</span>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            className="ml-auto"
            onClick={() => setReviewing(true)}
          >
            View plan
          </Button>
        </div>
        <AttentionContext context={card.item.context} planApproval />
        {feedback.length > 0 ? (
          <details className="mt-1 text-muted-foreground text-xs">
            <summary className="cursor-pointer select-none">
              {answered === "changes" ? "Feedback" : "Notes"}
            </summary>
            <p className="mt-1 whitespace-pre-wrap">{feedback}</p>
          </details>
        ) : null}
        {modal}
      </div>
    );
  }

  if (state === "resolved") {
    return (
      <div
        data-decision-card={card.item.id}
        data-decision-card-state="resolved"
        className="flex items-center gap-1.5 rounded-xl border border-border/50 border-dashed px-3 py-2 text-muted-foreground text-xs"
      >
        <span className="min-w-0 truncate font-medium">{header}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">Replaced or closed</span>
      </div>
    );
  }

  return (
    <div
      data-decision-card={card.item.id}
      data-decision-card-state="open"
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5"
    >
      <AttentionTaskLink card={card} environmentId={environmentId}>
        <PlanTitle
          as="div"
          meta={metaLine(key, `Plan approval · ${projectTitle}`, card.item.specVersion)}
          title={card.taskTitle}
        />
      </AttentionTaskLink>
      <AttentionContext context={card.item.context} planApproval />
      <TaskStructureLine relations={relations} />
      {plan === null ? (
        <PlanApprovalSections item={card.item} />
      ) : (
        <>
          <PlanSummary text={plan.summary} />
          <PlanTodoList todos={plan.todos} running={false} />
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={sending} onClick={() => approve(PLAN_APPROVAL_START)}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReviewing(true)}>
          {plan === null ? "Review plan" : "View details"}
        </Button>
        {plan !== null && plan.todos.length > 0 ? (
          <span data-plan-progress className="ms-auto text-muted-foreground text-xs">
            {planProgressLabel(plan.todos)}
          </span>
        ) : null}
      </div>
      {modal}
    </div>
  );
}

const LIVE_STAGES: ReadonlySet<ProjectTaskStage> = new Set([
  "awaiting_approval",
  "running",
  "in_review",
  "blocked",
]);

/**
 * The approved plan's steps and footer. While the task is live it reads the latest spec, so
 * steps tick as the lead checks them; once the task is finished it shows the pinned plan's
 * step count only, so old cards in the chat don't each keep a live query open.
 */
function LivePlanBoard(props: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  pinned: ProjectApprovalPlan;
  task: ProjectTaskReference | null;
  afk: boolean;
  onViewDetails: () => void;
}) {
  const stage = props.task?.stage ?? null;
  const live = stage !== null && LIVE_STAGES.has(stage);
  const phase =
    props.task === null ? null : (
      <LiveTaskPhaseBadge environmentId={props.environmentId} task={props.task} />
    );
  const steps =
    props.task === null ? null : (
      <TaskModelSteps
        environmentId={props.environmentId}
        steps={props.task.modelSteps}
        className="basis-full justify-end"
      />
    );
  if (!live) {
    // Done reads from the phase badge; a cancelled task has no phase, so it says so.
    return (
      <BoardFooter
        todos={props.pinned.todos}
        afk={props.afk}
        onViewDetails={props.onViewDetails}
        phase={phase}
        steps={steps}
        status={stage === "done" ? "" : stage === "cancelled" ? "Cancelled" : null}
      />
    );
  }
  return <LiveTodos {...props} stage={stage} phase={phase} steps={steps} />;
}

function LiveTodos(props: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  pinned: ProjectApprovalPlan;
  stage: ProjectTaskStage | null;
  phase: ReactNode;
  steps: ReactNode;
  afk: boolean;
  onViewDetails: () => void;
}) {
  const query = useTaskDetail(props.environmentId, {
    projectId: props.card.item.projectId,
    taskId: props.card.item.taskId,
  });
  const todos: ReadonlyArray<PlanTodoLike> =
    query.data?.versions.at(-1)?.spec.todos ?? props.pinned.todos;
  return (
    <>
      <PlanTodoList todos={todos} running={props.stage === "running"} />
      <BoardFooter
        todos={todos}
        afk={props.afk}
        onViewDetails={props.onViewDetails}
        phase={props.phase}
        steps={props.steps}
        status={null}
      />
    </>
  );
}

function BoardFooter(props: {
  todos: ReadonlyArray<Pick<PlanTodoLike, "done">>;
  afk: boolean;
  onViewDetails: () => void;
  phase: ReactNode;
  /** The model that ran each role, on its own line under the phase. */
  steps: ReactNode;
  /** Replaces the step count; "" shows none. */
  status: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onClick={props.onViewDetails}>
        View details
      </Button>
      {props.afk ? (
        <span className="text-muted-foreground text-xs">{AFK_ANSWERED_LABEL}</span>
      ) : null}
      <span className="ms-auto flex items-center gap-2">
        {props.phase}
        {props.status === "" ? null : (
          <span data-plan-progress className="text-muted-foreground text-xs">
            {props.status ?? (props.todos.length > 0 ? planProgressLabel(props.todos) : null)}
          </span>
        )}
      </span>
      {props.steps}
    </div>
  );
}
