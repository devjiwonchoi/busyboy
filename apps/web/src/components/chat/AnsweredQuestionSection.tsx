import type {
  OrchestrationV2UserInputQuestion,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { getQuestionAnswerText } from "@t3tools/client-runtime/work-log/user-input";
import { CheckIcon, MessageCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { splitPendingUserInputAnswerNote } from "../../pendingUserInput";
import { cn } from "~/lib/utils";

/**
 * A question the user already answered, kept in the timeline: the question, every
 * option with the picked ones checked, and any note or typed answer.
 */
export function AnsweredQuestionSection({
  questions,
  answer,
  renderAttachments,
}: {
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  answer: UserInputAttachmentAnswerPayload;
  renderAttachments?: (questionId: string) => ReactNode;
}) {
  const questionIds = [
    ...new Set([
      ...questions.map((question) => question.id),
      ...Object.keys(answer.questionTextById ?? {}),
      ...Object.keys(answer.answers),
    ]),
  ];
  return (
    <section
      aria-label="Answered question"
      data-answered-question={answer.requestId}
      className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
    >
      {questionIds.map((questionId) => {
        const question = questions.find((entry) => entry.id === questionId);
        const rawAnswer = answer.answers[questionId];
        const { choices, note } = splitPendingUserInputAnswerNote(rawAnswer);
        const options = question?.options ?? [];
        const isPicked = (option: { label: string; value?: string | undefined }) =>
          choices.includes(option.value ?? option.label) || choices.includes(option.label);
        const pickedAny = options.some(isPicked);
        // Without a matching option the user typed their own answer.
        const typedAnswer = pickedAny ? "" : getQuestionAnswerText(choices);
        return (
          <div key={questionId} className="space-y-1.5" data-answered-question-id={questionId}>
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <MessageCircleIcon className="size-3.5 shrink-0" />
              <span className="font-medium">{question?.header ?? "Question"}</span>
              <span>· Answered</span>
            </div>
            <p className="whitespace-pre-wrap text-foreground/85 text-sm">
              {question?.question ?? answer.questionTextById?.[questionId] ?? questionId}
            </p>
            {options.length > 0 ? (
              <ul className="space-y-0.5">
                {options.map((option) => {
                  const picked = isPicked(option);
                  return (
                    <li
                      key={option.value ?? option.label}
                      data-selected={picked ? "true" : undefined}
                      className={cn(
                        "flex items-start gap-2 rounded-md px-2 py-1 text-sm",
                        picked ? "bg-muted/55 text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                        {picked ? (
                          <CheckIcon aria-label="Picked" className="size-3.5 text-primary" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn(picked && "font-medium")}>{option.label}</span>
                        {option.description && option.description !== option.label ? (
                          <span className="block text-2xs text-secondary-label">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {typedAnswer ? (
              <p
                className="whitespace-pre-wrap text-foreground text-sm"
                data-answered-question-text
              >
                <span className="text-muted-foreground">Answer: </span>
                {typedAnswer}
              </p>
            ) : null}
            {note ? (
              <p
                className="whitespace-pre-wrap text-foreground text-sm"
                data-answered-question-note
              >
                <span className="text-muted-foreground">Note: </span>
                {note}
              </p>
            ) : null}
            {renderAttachments?.(questionId)}
          </div>
        );
      })}
    </section>
  );
}
