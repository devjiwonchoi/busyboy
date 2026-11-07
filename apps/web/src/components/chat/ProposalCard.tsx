import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ProjectDecisionCard,
  TASK_PROPOSAL_ACCEPT,
  TASK_PROPOSAL_DISMISS,
  taskProposalOutcome,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useProject } from "~/state/entities";
import { useAnswerDecision } from "~/state/projectTeam";
import { Button } from "../ui/button";
import { asChecklist, PlanMarkdown } from "./PlanMarkdown";

/** A proposal stays outside the task list until the user adds it. */
export function ProposalCard({
  card,
  environmentId,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
}) {
  const { item } = card;
  const project = useProject(
    scopeProjectRef(environmentId, card.proposal?.projectId ?? item.projectId),
  );
  const answerDecision = useAnswerDecision();
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const state =
    item.supersededAt !== null ? "resolved" : item.answeredAt !== null ? "answered" : "open";

  const submit = (answer: string) => {
    if (sending || answer.trim().length === 0) {
      return;
    }
    setSending(true);
    void answerDecision(environmentId, {
      projectId: item.projectId,
      attentionItemId: item.id,
      answer,
    }).then((result) => {
      // The attention stream supplies the answered card; a failure allows another attempt.
      if (!AsyncResult.isSuccess(result)) {
        setSending(false);
      }
    });
  };

  if (state !== "open") {
    const outcome = taskProposalOutcome(item.answer ?? "");
    const label =
      state === "resolved"
        ? "닫힘"
        : outcome === "accept"
          ? "추가됨"
          : outcome === "dismiss"
            ? "뺌"
            : "피드백 보냄";
    return (
      <div
        data-proposal-card={item.id}
        data-proposal-card-state={state}
        data-decision-card={item.id}
        className="rounded-xl border border-border/50 px-3 py-2 text-muted-foreground text-xs"
      >
        {label} · {item.question}
      </div>
    );
  }

  return (
    <div
      data-proposal-card={item.id}
      data-proposal-card-state="open"
      data-decision-card={item.id}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5"
    >
      <div>
        <p className="text-muted-foreground text-xs">
          태스크 제안 · {project?.title ?? "프로젝트"}
        </p>
        <h3 className="mt-1 font-semibold text-lg leading-snug">{item.question}</h3>
      </div>
      <section>
        <h4 className="font-semibold text-sm">목표</h4>
        <PlanMarkdown text={item.summary ?? ""} />
      </section>
      <section>
        <h4 className="font-semibold text-sm">확인 방법</h4>
        <PlanMarkdown text={asChecklist(item.verification ?? "")} />
      </section>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={sending} onClick={() => submit(TASK_PROPOSAL_ACCEPT)}>
          태스크로 추가
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={sending}
          onClick={() => submit(TASK_PROPOSAL_DISMISS)}
        >
          빼기
        </Button>
      </div>
      <textarea
        aria-label="피드백"
        value={feedback}
        disabled={sending}
        onChange={(event) => setFeedback(event.target.value)}
        rows={2}
        placeholder="제안에 대한 피드백"
        className="min-w-0 resize-y rounded-lg border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 sm:text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={
          sending || feedback.trim().length === 0 || taskProposalOutcome(feedback) !== "feedback"
        }
        onClick={() => submit(feedback.trim())}
      >
        피드백 보내기
      </Button>
    </div>
  );
}
