import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectDecisionCard,
  ProjectLeadQuestionQuote,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadProjection } from "~/state/entities";
import { useAskLead } from "~/state/projectTeam";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { useAttentionTask } from "./AttentionContext";
import { selectLeadQuestionThread } from "./CardSideChat.logic";

export const CARD_SIDE_CHAT_TITLE = "리드에게 질문";

const NO_QUOTES: ReadonlyArray<ProjectLeadQuestionQuote> = [];

/** A question that was sent and is not in the lead thread yet. */
interface SentQuestion {
  readonly messageId: string;
  readonly question: string;
  readonly quotes: ReadonlyArray<ProjectLeadQuestionQuote>;
}

function QuoteBlock({ text }: { text: string }) {
  return (
    <blockquote className="mb-1 line-clamp-4 whitespace-pre-wrap border-muted-foreground/40 border-s-2 ps-2 text-muted-foreground text-xs">
      {text}
    </blockquote>
  );
}

function QuestionBubble({ quotes, question }: { quotes: ReadonlyArray<string>; question: string }) {
  return (
    <div
      data-card-side-chat-question
      className="ms-auto max-w-[85%] rounded-xl bg-muted px-3 py-2 text-sm"
    >
      {quotes.map((quote, index) => (
        <QuoteBlock key={index} text={quote} />
      ))}
      <p className="whitespace-pre-wrap wrap-break-word">{question}</p>
    </div>
  );
}

/**
 * The side chat beside a card's detail: questions for the lead that raised the card and the
 * lead's replies, read live from the lead thread. Asking never answers or closes the card.
 */
export function CardSideChat({
  card,
  environmentId,
  quotes = NO_QUOTES,
  onRemoveQuote,
  onSent,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  /** Card passages to send with the next question. */
  quotes?: ReadonlyArray<ProjectLeadQuestionQuote>;
  onRemoveQuote?: (quote: ProjectLeadQuestionQuote) => void;
  /** The question went out with these quotes; the parent drops them. */
  onSent?: () => void;
}) {
  const { related, projectTitle } = useAttentionTask({ card, environmentId });
  // The task's own lead and project: a Director card is asked by the Director, from its
  // system project. Null until the task list has the task.
  const leadThreadId = related?.task.leadThreadId ?? null;
  const leadRef = leadThreadId === null ? null : scopeThreadRef(environmentId, leadThreadId);
  const messages = useThreadProjection(leadRef)?.projection.messages ?? [];
  const askLead = useAskLead();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState<ReadonlyArray<SentQuestion>>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = selectLeadQuestionThread(messages, card.item.id);
  // Sent questions show right away, until the lead thread has them.
  const delivered = new Set<string>(messages.map((message) => message.id));
  const pending = sent.filter((entry) => !delivered.has(entry.messageId));
  const last = entries.at(-1);
  const waiting = pending.length > 0 || last?.kind === "question";
  const streaming = last?.kind === "answer" && last.streaming;
  const lastText = last?.kind === "answer" ? last.text : "";

  // Follow the conversation as questions and streamed answers come in.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [entries.length, lastText, pending.length]);

  const context = [projectTitle, related ? `${related.key} ${card.taskTitle}` : card.taskTitle]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" · ");

  const send = () => {
    const question = draft.trim();
    if (question.length === 0 || sending || leadThreadId === null) return;
    setSending(true);
    setFailed(false);
    const asked = { question, quotes: [...quotes] };
    void askLead(environmentId, {
      projectId: card.item.projectId,
      attentionItemId: card.item.id,
      ...asked,
    }).then((result) => {
      setSending(false);
      if (AsyncResult.isSuccess(result)) {
        setSent([...sent, { ...asked, messageId: result.value.messageId }]);
        setDraft("");
        onSent?.();
      } else {
        setFailed(true);
      }
    });
  };

  return (
    <section
      data-card-side-chat={card.item.id}
      aria-label={CARD_SIDE_CHAT_TITLE}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <header className="shrink-0 border-b px-4 py-3">
        <h2 className="font-semibold text-sm">{CARD_SIDE_CHAT_TITLE}</h2>
        <p data-card-side-chat-context className="truncate text-muted-foreground text-xs">
          {context}
        </p>
      </header>
      <div
        ref={listRef}
        data-card-side-chat-messages
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
      >
        {entries.length === 0 && pending.length === 0 ? (
          <p className="m-auto max-w-64 text-center text-muted-foreground text-sm">
            이 카드에 대해 궁금한 걸 물어보세요. 질문해도 카드는 그대로예요.
          </p>
        ) : null}
        {entries.map((entry) =>
          entry.kind === "question" ? (
            <QuestionBubble key={entry.id} quotes={entry.quotes} question={entry.question} />
          ) : (
            <div key={entry.id} data-card-side-chat-answer className="min-w-0 text-sm">
              <ChatMarkdown
                text={entry.text}
                cwd={undefined}
                threadRef={leadRef ?? undefined}
                isStreaming={entry.streaming}
              />
            </div>
          ),
        )}
        {pending.map((entry) => (
          <QuestionBubble
            key={entry.messageId}
            quotes={entry.quotes.map((quote) => quote.quote)}
            question={entry.question}
          />
        ))}
        {waiting ? (
          <p role="status" className="text-muted-foreground text-xs">
            리드에게 보냈어요. 답을 기다리는 중…
          </p>
        ) : streaming ? (
          <p role="status" className="text-muted-foreground text-xs">
            리드가 답하는 중…
          </p>
        ) : null}
      </div>
      {leadThreadId === null ? (
        <p className="shrink-0 border-t px-4 py-3 text-muted-foreground text-sm">
          이 카드는 리드와 연결되어 있지 않아요.
        </p>
      ) : (
        <div className="flex shrink-0 flex-col gap-2 border-t px-3 py-3">
          {quotes.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="인용">
              {quotes.map((quote, index) => (
                <li
                  key={index}
                  data-card-side-chat-quote
                  className="flex items-start gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                >
                  <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap">
                    “{quote.quote}”
                  </span>
                  <button
                    type="button"
                    aria-label="인용 빼기"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => onRemoveQuote?.(quote)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            aria-label={CARD_SIDE_CHAT_TITLE}
            placeholder="리드에게 물어볼 내용"
            data-card-side-chat-input
            rows={2}
            value={draft}
            className="w-full min-w-0 resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="flex items-center gap-2">
            {failed ? (
              <p role="alert" className="text-destructive-foreground text-xs">
                보내지 못했어요. 다시 시도해 주세요.
              </p>
            ) : null}
            <Button
              size="sm"
              className="ms-auto"
              data-card-side-chat-send
              disabled={sending || draft.trim().length === 0}
              onClick={send}
            >
              보내기
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export type CardDetailTab = "card" | "chat";

/**
 * A card's detail with its side chat: side by side from md up, and tabs on phones so the
 * card and the chat each get the whole screen.
 */
export function CardDetailWithSideChat({
  detail,
  sideChat,
  tab,
  onTabChange,
  className,
}: {
  detail: ReactNode;
  sideChat: ReactNode;
  tab: CardDetailTab;
  onTabChange: (tab: CardDetailTab) => void;
  className?: string;
}) {
  const tabButton = (value: CardDetailTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      data-card-detail-tab={value}
      className={cn(
        "flex-1 border-b-2 py-2 text-sm",
        tab === value
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground",
      )}
      onClick={() => onTabChange(value)}
    >
      {label}
    </button>
  );
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_22.5rem]",
        className,
      )}
    >
      <div role="tablist" className="flex shrink-0 border-b md:hidden">
        {tabButton("card", "카드")}
        {tabButton("chat", CARD_SIDE_CHAT_TITLE)}
      </div>
      <div
        data-card-detail-pane="card"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:flex",
          tab === "card" ? "flex" : "hidden",
        )}
      >
        {detail}
      </div>
      <div
        data-card-detail-pane="chat"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:flex md:border-s",
          tab === "chat" ? "flex" : "hidden",
        )}
      >
        {sideChat}
      </div>
    </div>
  );
}
