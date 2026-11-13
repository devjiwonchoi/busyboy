import type { EnvironmentId } from "@t3tools/contracts";
import { splitAssistantMarkdownIntoBubbles } from "@t3tools/shared/chatBubbles";
import type { ActionCard as ActionCardModel, ActionCardOption } from "@t3tools/shared/one-chat";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { FlatList, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ActionCard } from "./action-card";
import { ChatBubble } from "./chat-bubble";
import type { ChatMessage } from "./use-one-chat-data";

export type FeedItem =
  | { readonly key: string; readonly kind: "user" | "assistant" | "notice"; readonly text: string }
  | { readonly key: string; readonly kind: "card"; readonly card: ActionCardModel }
  | { readonly key: string; readonly kind: "working" };

/** Messages and cards in time order; assistant replies split into bubbles. */
export function buildFeedItems(
  messages: ReadonlyArray<ChatMessage>,
  cards: ReadonlyArray<ActionCardModel>,
  running: boolean,
): FeedItem[] {
  const timed: Array<{ at: string; order: number; items: FeedItem[] }> = [];
  messages.forEach((message, order) => {
    const items: FeedItem[] =
      message.role === "assistant"
        ? splitAssistantMarkdownIntoBubbles(message.text).map((text, index) => ({
            key: `${message.id}:${index}`,
            kind: "assistant" as const,
            text,
          }))
        : [{ key: message.id, kind: message.role, text: message.text }];
    timed.push({ at: message.createdAt, order, items });
  });
  cards.forEach((card, order) => {
    timed.push({
      at: card.createdAt,
      order: messages.length + order,
      items: [{ key: `card:${card.id}`, kind: "card", card }],
    });
  });
  const items = timed
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.order - b.order)
    .flatMap((entry) => entry.items);
  if (running) items.push({ key: "working", kind: "working" });
  return items;
}

export interface OneChatFeedHandle {
  readonly scrollToCard: (cardId: string) => void;
}

export const OneChatFeed = forwardRef<
  OneChatFeedHandle,
  {
    readonly items: ReadonlyArray<FeedItem>;
    readonly environmentId: EnvironmentId | null;
    readonly answeredLabels: Readonly<Record<string, string>>;
    readonly highlightedCardId: string | null;
    readonly onAnswer: (card: ActionCardModel, option: ActionCardOption) => void;
    readonly onOpenDetails: (card: ActionCardModel) => void;
  }
>(function OneChatFeed(props, ref) {
  const listRef = useRef<FlatList<FeedItem>>(null);
  const shownCount = useRef(0);
  const items = useMemo(() => [...props.items], [props.items]);
  useImperativeHandle(
    ref,
    () => ({
      scrollToCard: (cardId) => {
        const index = items.findIndex((item) => item.key === `card:${cardId}`);
        if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      },
    }),
    [items],
  );
  return (
    <FlatList
      ref={listRef}
      testID="one-chat-feed"
      data={items}
      keyExtractor={(item) => item.key}
      contentContainerStyle={{ paddingVertical: 12 }}
      keyboardDismissMode="interactive"
      onContentSizeChange={() => {
        // Follow new messages only; a jump to a card must not be undone by a re-layout.
        if (items.length === shownCount.current) return;
        shownCount.current = items.length;
        listRef.current?.scrollToEnd({ animated: false });
      }}
      onScrollToIndexFailed={(info) =>
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: true,
        })
      }
      renderItem={({ item }) => {
        switch (item.kind) {
          case "user":
          case "assistant":
            return <ChatBubble role={item.kind} text={item.text} />;
          case "notice":
            return (
              <Text className="mx-6 my-1 text-center text-xs text-foreground-muted">
                {item.text}
              </Text>
            );
          case "card":
            return (
              <ActionCard
                card={item.card}
                environmentId={props.environmentId}
                answeredLabel={props.answeredLabels[item.card.id] ?? null}
                highlighted={props.highlightedCardId === item.card.id}
                onAnswer={props.onAnswer}
                onOpenDetails={props.onOpenDetails}
              />
            );
          case "working":
            return (
              <View className="mx-4 my-1 self-start">
                <Text className="text-sm text-foreground-muted">Working…</Text>
              </View>
            );
        }
      }}
    />
  );
});
