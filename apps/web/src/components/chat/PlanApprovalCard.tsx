import {
  type EnvironmentId,
  PLAN_APPROVAL_START,
  planApprovalOutcome,
  type PlanApprovalOutcome,
  type ProjectDecisionCard,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useAnswerDecision } from "~/state/projectTeam";

import { Button } from "../ui/button";
import { AFK_ANSWERED_LABEL } from "./Afk";
import { PlanApprovalModal } from "./PlanApprovalModal";
import { PlanApprovalSections } from "./PlanMarkdown";

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

/**
 * A task lead's plan, waiting for the user's go-ahead. Open: the lead's Goal and Verification,
 * the Approve button (same answer call as the modal, so it counts as the user's click; it
 * always starts the work) and "Review plan" for the full plan, comments and requested changes. Answered: the outcome, with the plan still viewable. Closed unanswered: muted.
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
  const header = planApprovalHeader(card);
  const answer = card.item.answer;
  const state =
    card.item.answeredAt !== null
      ? "answered"
      : card.item.supersededAt !== null
        ? "resolved"
        : "open";

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

  if (state === "answered") {
    const outcome = planApprovalOutcome(answer ?? "");
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
          <span data-plan-outcome={outcome}>{OUTCOME_LABEL[outcome]}</span>
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
        {outcome === "changes" && feedback.length > 0 ? (
          <details className="mt-1 text-muted-foreground text-xs">
            <summary className="cursor-pointer select-none">Feedback</summary>
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
      <p className="truncate font-medium text-muted-foreground text-xs">{header}</p>
      <PlanApprovalSections item={card.item} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={sending} onClick={() => approve(PLAN_APPROVAL_START)}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReviewing(true)}>
          Review plan
        </Button>
      </div>
      {modal}
    </div>
  );
}
