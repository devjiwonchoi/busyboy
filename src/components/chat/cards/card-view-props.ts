import type { TaskCard } from "@/server/cards/model";

export type CardViewProps<T extends TaskCard = TaskCard> = { card: T };
