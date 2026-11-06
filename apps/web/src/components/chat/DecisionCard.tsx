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
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { AnsweredQuestionSection } from "./AnsweredQuestionSection";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const QUESTION_ID = "answer";

const KIND_LABEL: Record<ProjectDecisionCard["item"]["kind"], string> = {
  decision: "Decision",
  blocker: "Blocker",
};

/** Questions asked without options still need something to pick; the note carries the detail. */
function cardOptions(card: ProjectDecisionCard): ReadonlyArray<string> {
  if (card.item.options.length > 0) return card.item.options;
  return ["Give feedback"];
}

/** "Decision · Fix login", or "Decision · BB-7 Fix login" where the task isn't obvious. */
export function decisionCardHeader(card: ProjectDecisionCard, taskKey?: string): string {
  const task = taskKey === undefined ? card.taskTitle : `${taskKey} ${card.taskTitle}`;
  return `${KIND_LABEL[card.item.kind]} · ${task}`;
}

/** The card's question in the shape the shared question card renders. */
export function decisionCardQuestion(
  card: ProjectDecisionCard,
  taskKey?: string,
): OrchestrationV2UserInputQuestion {
  return {
    id: QUESTION_ID,
    header: decisionCardHeader(card, taskKey),
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
 * Closed unanswered (its task ended, or the conversation made it moot): the muted question
 * marked "No longer needed".
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
      <div
        data-decision-card={card.item.id}
        data-decision-card-state="resolved"
        className="rounded-xl border border-border/50 border-dashed px-3 py-2 text-muted-foreground text-xs"
      >
        <p className="flex items-center gap-1.5">
          <span className="font-medium">{decisionCardHeader(card)}</span>
          <span aria-hidden>·</span>
          <span>No longer needed</span>
        </p>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{card.item.question}</p>
      </div>
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

/** The answerable card, with its own border. */
export function OpenDecisionCard({
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
  const [fullScreen, setFullScreen] = useState(false);
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

  // The inline card and the full-screen view render the same draft, so a pick or note carries over.
  const panel = (expanded: boolean) => (
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
      expanded={expanded}
      onToggleExpanded={() => setFullScreen(!expanded)}
      {...(expanded ? { scrollClassName: "max-h-[calc(90dvh-3rem)]" } : {})}
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
  );

  return (
    <div
      data-decision-card={card.item.id}
      data-decision-card-state="open"
      className="rounded-xl border border-border/70 bg-card/60 py-1"
    >
      {panel(false)}
      {/* Once answered, the card leaves the open state and this view closes with it. */}
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        <DialogPopup
          showCloseButton={false}
          bottomStickOnMobile={false}
          className="max-h-[90dvh] w-[min(92vw,64rem)] max-w-none py-1"
          data-decision-card-expanded={card.item.id}
        >
          <DialogTitle className="sr-only">{question.header}</DialogTitle>
          {panel(true)}
        </DialogPopup>
      </Dialog>
    </div>
  );
}
