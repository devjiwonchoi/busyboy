import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { ActionCard, ActionCardOption } from "@t3tools/shared/one-chat";
import { useEffect, useRef } from "react";

import { ActionCardView } from "./action-card";
import { MessageBubbles } from "./chat-bubbles";
import { type FeedMessage, toMillis } from "./one-chat-data";

type FeedEntry =
  | { readonly kind: "message"; readonly at: number; readonly message: FeedMessage }
  | { readonly kind: "card"; readonly at: number; readonly card: ActionCard };

/** Messages and cards in one timeline, oldest first. */
export function feedEntries(
  messages: ReadonlyArray<FeedMessage>,
  cards: ReadonlyArray<ActionCard>,
): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...messages.map((message) => ({ kind: "message" as const, at: message.at, message })),
    ...cards.map((card) => ({ kind: "card" as const, at: toMillis(card.createdAt), card })),
  ];
  return entries.toSorted((a, b) => a.at - b.at);
}

/** The Director chat: its messages with the action cards in between. */
export function OneChatFeed({
  messages,
  cards,
  running,
  threadRef,
  environmentId,
  onPick,
  onOpenDetails,
}: {
  messages: ReadonlyArray<FeedMessage>;
  cards: ReadonlyArray<ActionCard>;
  running: boolean;
  threadRef: ScopedThreadRef | null;
  environmentId: EnvironmentId | null;
  onPick: (card: ActionCard, option: ActionCardOption) => void;
  onOpenDetails: (card: ActionCard) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const entries = feedEntries(messages, cards);
  const last = messages.at(-1);

  // Stay at the bottom as messages arrive and replies stream in.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [entries.length, last?.text, running]);

  return (
    <div ref={listRef} data-one-chat-feed className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-4">
        {entries.map((entry) =>
          entry.kind === "message" ? (
            <MessageBubbles key={entry.message.id} message={entry.message} threadRef={threadRef} />
          ) : (
            <ActionCardView
              key={entry.card.id}
              card={entry.card}
              environmentId={environmentId}
              onPick={onPick}
              onOpenDetails={onOpenDetails}
            />
          ),
        )}
        {running ? (
          <p role="status" data-one-chat-working className="text-muted-foreground text-xs">
            Working…
          </p>
        ) : null}
      </div>
    </div>
  );
}
