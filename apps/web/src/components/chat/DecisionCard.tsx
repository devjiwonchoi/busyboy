import {
  isTurnFailedBlocker,
  TURN_FAILED_RETRY,
  TURN_FAILED_CANCEL,
  type EnvironmentId,
  type OrchestrationV2UserInputQuestion,
  type ProjectDecisionCard,
  RuntimeRequestId,
  type ScopedThreadRef,
  type UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";

import { resolvePendingUserInputAnswer } from "../../pendingUserInput";
import { useAnswerDecision } from "../../state/projectTeam";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { AnsweredQuestionSection } from "./AnsweredQuestionSection";
import ChatMarkdown from "../ChatMarkdown";
import { useRelatedTask } from "../task/TaskRelations";
import { Button } from "../ui/button";
import { parseDecisionOption, splitDecisionQuestion } from "./DecisionCard.logic";
import { AFK_ANSWERED_LABEL } from "./Afk";
import { ProposalCard } from "./ProposalCard";
import { PlanApprovalCard } from "./PlanApprovalCard";

const QUESTION_ID = "answer";

const KIND_LABEL: Record<ProjectDecisionCard["item"]["kind"], string> = {
  decision: "Decision",
  approval: "Plan approval",
  blocker: "Blocker",
  proposal: "태스크 제안",
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
 * A task lead's question in the PM thread. Open: a question title, folded context, radio choices and a visible
 * note field with explicit submission; the answer goes straight to the lead. Answered: the question and the choice.
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
  const related = useRelatedTask(environmentId, card.item.taskId);
  if (card.item.kind === "proposal") {
    return <ProposalCard card={card} environmentId={environmentId} />;
  }
  if (card.item.kind === "approval") {
    return <PlanApprovalCard card={card} environmentId={environmentId} />;
  }
  const question = decisionCardQuestion(card, related?.key);
  if (card.item.answeredAt !== null) {
    return (
      <div data-decision-card={card.item.id} data-decision-card-state="answered">
        <AnsweredQuestionSection
          questions={[question]}
          answer={answeredPayload(card)}
          answeredLabel={card.item.answeredBy === "afk" ? AFK_ANSWERED_LABEL : "Answered"}
        />
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
          <span className="font-medium">{question.header}</span>
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
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const { headline, context } = splitDecisionQuestion(card.item.question);
  const options = card.item.options.map(parseDecisionOption);
  const turnFailed = isTurnFailedBlocker(card.item);
  // A typed answer stands on its own, so a pick is optional whenever the note has text.
  const canSubmit = !sending && (turnFailed || picked !== null || note.trim().length > 0);

  const submit = (choice: string | undefined) => {
    if (!canSubmit) {
      return;
    }
    const selected = choice ?? (turnFailed ? TURN_FAILED_RETRY : picked);
    const answer =
      selected === null && options.length > 0
        ? note.trim()
        : resolvePendingUserInputAnswer(question, {
            selectedOptionValues: [selected ?? "Give feedback"],
            note: choice === TURN_FAILED_CANCEL ? "" : note,
          });
    setSending(true);
    void answerDecision(environmentId, {
      projectId: card.item.projectId,
      attentionItemId: card.item.id,
      answer: answer as string,
    }).then((result) => {
      // On success the attention stream replaces the open card; failure preserves the draft.
      if (!AsyncResult.isSuccess(result)) {
        setSending(false);
      }
    });
  };

  // Both views share the draft, while each context box measures its own available space.
  const panel = (expanded: boolean) => (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p data-decision-card-meta className="truncate text-xs text-muted-foreground">
            {question.header}
          </p>
          <h3 data-decision-card-headline className="wrap-break-word text-base font-semibold">
            {headline}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={expanded ? "Exit full screen" : "Open full screen"}
          data-decision-card-expand={expanded ? "expanded" : "inline"}
          onClick={() => setFullScreen(!expanded)}
        >
          {expanded ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
        </Button>
      </div>
      {context ? (
        <DecisionContext context={context} expanded={expanded} cwd={cwd} threadRef={threadRef} />
      ) : null}
      {!turnFailed && options.length > 0 ? (
        <div role="radiogroup" aria-label={headline} className="flex min-w-0 flex-col gap-2">
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={picked === option.value}
              tabIndex={picked === option.value || (picked === null && index === 0) ? 0 : -1}
              disabled={sending}
              onClick={() => setPicked(option.value)}
              onKeyDown={(event) => {
                if (sending) {
                  return;
                }
                let next: number;
                switch (event.key) {
                  case "ArrowDown":
                  case "ArrowRight":
                    next = (index + 1) % options.length;
                    break;
                  case "ArrowUp":
                  case "ArrowLeft":
                    next = (index + options.length - 1) % options.length;
                    break;
                  case "Home":
                    next = 0;
                    break;
                  case "End":
                    next = options.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                setPicked(options[next]!.value);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                  [next]?.focus();
              }}
              className={`flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-left disabled:opacity-50 ${picked === option.value ? "border-primary bg-primary/5" : "border-border"}`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${picked === option.value ? "border-primary" : "border-muted-foreground"}`}
              >
                {picked === option.value ? (
                  <span className="size-2 rounded-full bg-primary" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 wrap-break-word">
                <span className="text-sm font-medium">{option.label}</span>
                {option.recommended ? (
                  <span
                    data-decision-option-recommended
                    className="ml-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                  >
                    Recommended
                  </span>
                ) : null}
                {option.tradeoff ? (
                  <span
                    data-decision-option-tradeoff
                    className="mt-1 block text-xs text-muted-foreground"
                  >
                    {option.tradeoff}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        aria-label={turnFailed ? "리드에게 전할 말" : "Note for your answer"}
        placeholder={
          turnFailed
            ? "리드에게 전할 말 (선택)"
            : options.length > 0
              ? "Write your own answer, or add a note to your pick"
              : "Write your answer"
        }
        data-decision-card-note
        rows={2}
        value={note}
        disabled={sending}
        className="w-full min-w-0 resize-y rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit(undefined);
          }
        }}
      />
      <div className="flex flex-wrap gap-2">
        {turnFailed ? (
          <>
            <Button
              size="sm"
              data-decision-card-retry
              disabled={sending}
              onClick={() => submit(TURN_FAILED_RETRY)}
            >
              {TURN_FAILED_RETRY}
            </Button>
            <Button
              size="sm"
              variant="ghost-destructive"
              data-decision-card-cancel
              disabled={sending}
              onClick={() => submit(TURN_FAILED_CANCEL)}
            >
              {TURN_FAILED_CANCEL}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            data-decision-card-submit
            disabled={!canSubmit}
            onClick={() => submit(undefined)}
          >
            Submit
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-decision-card={card.item.id}
      data-decision-card-state="open"
      data-decision-card-variant={turnFailed ? "turn-failed" : undefined}
      className={`flex min-w-0 flex-col gap-2 rounded-xl border ${turnFailed ? "border-destructive/40" : "border-border/70"} bg-card/60 px-3 py-2.5`}
    >
      {panel(false)}
      {/* Once answered, the card leaves the open state and this view closes with it. */}
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        <DialogPopup
          showCloseButton={false}
          bottomStickOnMobile={false}
          className={`max-h-[90dvh] w-[min(92vw,64rem)] max-w-none ${turnFailed ? "border-destructive/40" : ""}`}
          data-decision-card-expanded={card.item.id}
          data-decision-card-variant={turnFailed ? "turn-failed" : undefined}
        >
          <DialogTitle className="sr-only">{headline}</DialogTitle>
          <div className="max-h-[90dvh] overflow-y-auto">{panel(true)}</div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

/** Measure the folded box so short context never gains an unnecessary toggle. */
function DecisionContext({
  context,
  expanded,
  cwd,
  threadRef,
}: {
  context: string;
  expanded: boolean;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [unfolded, setUnfolded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const box = ref.current;
    if (!box || expanded) {
      return;
    }
    const measure = () => {
      if (!unfolded) {
        setOverflows(box.scrollHeight > box.clientHeight + 1);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild) {
      observer.observe(box.firstElementChild);
    }
    return () => observer.disconnect();
  }, [context, expanded, unfolded]);

  return (
    <div className="min-w-0">
      <div className="relative">
        <div
          ref={ref}
          data-decision-card-context
          className={`min-w-0 wrap-break-word ${expanded || unfolded ? "" : "max-h-[7.5rem] overflow-hidden"}`}
        >
          <ChatMarkdown text={context} cwd={cwd} threadRef={threadRef} />
        </div>
        {!expanded && !unfolded && overflows ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-card to-transparent"
          />
        ) : null}
      </div>
      {!expanded && overflows ? (
        <Button
          variant="ghost"
          size="sm"
          data-decision-card-context-toggle
          aria-expanded={unfolded}
          onClick={() => setUnfolded(!unfolded)}
        >
          {unfolded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
