import {
  type EnvironmentId,
  type OrchestrationV2UserInputQuestion,
  type ProjectDecisionCard,
  RuntimeRequestId,
  type ScopedThreadRef,
  type UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import {
  resolvePendingUserInputAnswer,
  setPendingUserInputNote,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { useAnswerDecision } from "../../state/projectTeam";
import { AnsweredQuestionSection } from "./AnsweredQuestionSection";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const QUESTION_ID = "answer";

const KIND_LABEL: Record<ProjectDecisionCard["item"]["kind"], string> = {
  approval: "Plan approval",
  decision: "Decision",
  blocker: "Blocker",
};

/** Questions asked without options still need something to pick; the note carries the detail. */
function cardOptions(card: ProjectDecisionCard): ReadonlyArray<string> {
  if (card.item.options.length > 0) return card.item.options;
  return card.item.kind === "approval" ? ["Approve", "Request changes"] : ["Give feedback"];
}

export function decisionCardHeader(card: ProjectDecisionCard): string {
  return `${KIND_LABEL[card.item.kind]} · ${card.taskTitle}`;
}

/** The card's question in the shape the shared question card renders. */
export function decisionCardQuestion(card: ProjectDecisionCard): OrchestrationV2UserInputQuestion {
  return {
    id: QUESTION_ID,
    header: decisionCardHeader(card),
    question: card.item.question,
    options: cardOptions(card).map((label) => ({ label, description: label })),
    multiSelect: false,
    allowCustomAnswer: true,
  };
}

function answeredPayload(card: ProjectDecisionCard): UserInputAttachmentAnswerPayload {
  return {
    requestId: RuntimeRequestId.make(card.item.id),
    answers: { [QUESTION_ID]: card.item.answer ?? "" },
    attachmentsByQuestionId: {},
    questionTextById: { [QUESTION_ID]: card.item.question },
  };
}

/**
 * A task lead's question in the PM thread. Open: the question card with its options and a
 * note field; the answer goes straight to the lead. Answered: the question and the choice.
 * Replaced by a newer plan: one muted line.
 */
export function DecisionCard({
  card,
  environmentId,
  threadRef,
  cwd,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const question = decisionCardQuestion(card);
  if (card.item.answeredAt !== null) {
    return (
      <div data-decision-card={card.item.id} data-decision-card-state="answered">
        <AnsweredQuestionSection questions={[question]} answer={answeredPayload(card)} />
      </div>
    );
  }
  if (card.item.supersededAt !== null) {
    return (
      <p
        data-decision-card={card.item.id}
        data-decision-card-state="superseded"
        className="px-1 text-muted-foreground text-xs"
      >
        {decisionCardHeader(card)}: replaced by a newer plan.
      </p>
    );
  }
  return (
    <OpenDecisionCard
      card={card}
      question={question}
      environmentId={environmentId}
      threadRef={threadRef}
      cwd={cwd}
    />
  );
}

function OpenDecisionCard({
  card,
  question,
  environmentId,
  threadRef,
  cwd,
}: {
  card: ProjectDecisionCard;
  question: OrchestrationV2UserInputQuestion;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const answerDecision = useAnswerDecision();
  const [draft, setDraft] = useState<PendingUserInputDraftAnswer | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const requestId = RuntimeRequestId.make(card.item.id);
  const panelQuestion = { ...question, multiSelect: false };

  const submit = (nextDraft: PendingUserInputDraftAnswer | undefined) => {
    const resolved = resolvePendingUserInputAnswer(panelQuestion, nextDraft);
    if (typeof resolved !== "string" || resolved.trim().length === 0 || sending) return;
    setSending(true);
    void answerDecision(environmentId, {
      projectId: card.item.projectId,
      attentionItemId: card.item.id,
      answer: resolved,
    }).then((result) => {
      // On success the attention stream turns this card into its answered section.
      if (!AsyncResult.isSuccess(result)) setSending(false);
    });
  };

  return (
    <div
      data-decision-card={card.item.id}
      data-decision-card-state="open"
      className="rounded-xl border border-border/70 bg-card/60 py-1"
    >
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId,
            createdAt: card.item.createdAt,
            questions: [panelQuestion],
            responseCapability: "message",
            dismissible: false,
          },
        ]}
        cwd={cwd}
        threadRef={threadRef}
        respondingRequestIds={sending ? [requestId] : []}
        answers={draft ? { [QUESTION_ID]: draft } : {}}
        questionIndex={0}
        keyboardShortcuts={false}
        onToggleOption={(_questionId, optionValue) =>
          setDraft((current) =>
            togglePendingUserInputOptionSelection(panelQuestion, current, optionValue),
          )
        }
        onChangeNote={(_questionId, note) =>
          setDraft((current) => setPendingUserInputNote(current, note))
        }
        onAdvance={() => submit(draft)}
        onDismiss={() => undefined}
      />
    </div>
  );
}
