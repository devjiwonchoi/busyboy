"use client";

import type { TaskCard } from "@/server/cards/model";

import { CardActionProvider } from "./card-actions";
import { TimelineCardView } from "./card-view";

export function OpenCard({
  card,
  replying,
  onReplyChange,
}: {
  card: TaskCard;
  replying: boolean;
  onReplyChange: (replying: boolean) => void;
}) {
  return (
    <CardActionProvider card={card} replying={replying} onReplyChange={onReplyChange}>
      <TimelineCardView card={card} />
    </CardActionProvider>
  );
}
