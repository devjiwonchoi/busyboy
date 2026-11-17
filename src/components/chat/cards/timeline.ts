import type { TaskCard } from "@/server/cards/model";
import type { ChatEntry } from "@/server/director/chat";

export type TimelineRow =
  | { type: "entry"; at: string; key: string; entry: ChatEntry }
  | { type: "card"; at: string; key: string; card: TaskCard };

export function mergeTimeline(entries: ChatEntry[], cards: TaskCard[]): TimelineRow[] {
  const rows: TimelineRow[] = [
    ...entries.map((entry) => ({
      type: "entry" as const,
      at: entry.at,
      key: `entry:${entry.id}`,
      entry,
    })),
    ...cards.map((card) => ({
      type: "card" as const,
      at: card.openedAt,
      key: `card:${card.id}`,
      card,
    })),
  ];
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : 1));
  return rows;
}
