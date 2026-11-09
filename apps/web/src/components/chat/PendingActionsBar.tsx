import type { LegendListRef } from "@legendapp/list/react";
import type { ThreadId } from "@t3tools/contracts";
import { BellDotIcon } from "lucide-react";

import type { PendingActionItem } from "../../state/projectTeam.logic";
import { Button } from "../ui/button";
import { useState } from "react";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const HIGHLIGHT_MS = 1800;
const REVEAL_ATTEMPTS = 30;

function cardElement(scrollNode: Element, cardId: string): HTMLElement | null {
  return scrollNode.querySelector<HTMLElement>(`[data-decision-card="${CSS.escape(cardId)}"]`);
}

/** True when part of the element shows inside the scroll viewport. */
function isInView(scrollNode: Element, element: HTMLElement): boolean {
  const viewport = scrollNode.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

function flash(element: HTMLElement) {
  element.dataset.decisionCardHighlighted = "true";
  window.setTimeout(() => {
    delete element.dataset.decisionCardHighlighted;
  }, HIGHLIGHT_MS);
}

/** Scrolls the timeline to a question card and flashes it; the row may mount only on arrival. */
export function revealDecisionCard(list: LegendListRef | null, cardId: string): void {
  if (!list) return;
  const index = list.getState().indexByKey(`decision-card:${cardId}`);
  if (index !== undefined) {
    void list.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 24 });
  }
  let attempts = 0;
  const tryFlash = () => {
    const scrollNode = list.getScrollableNode();
    const element = scrollNode ? cardElement(scrollNode, cardId) : null;
    if (element && (index === undefined || isInView(scrollNode!, element))) {
      if (index === undefined) element.scrollIntoView({ block: "start", behavior: "smooth" });
      flash(element);
      return;
    }
    attempts += 1;
    if (attempts < REVEAL_ATTEMPTS) window.setTimeout(tryFlash, 50);
  };
  tryFlash();
}

type PendingActionsInput = {
  readonly id: string;
  readonly items: ReadonlyArray<PendingActionItem>;
  readonly onRevealCard: (cardId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
};

/** Keep stepping local to the mounted banner, starting with the first item. */
function PendingActionsStepper(props: PendingActionsInput) {
  const [followedId, setFollowedId] = useState<string | null>(null);
  const idOf = (item: PendingActionItem) => (item.kind === "card" ? item.id : item.threadId);
  const followedIndex = props.items.findIndex((item) => idOf(item) === followedId);
  const shown = props.items[Math.max(0, followedIndex)];
  const next = props.items[(followedIndex + 1) % props.items.length];
  if (!shown || !next) {
    return null;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">
        기다리는 일 {Math.max(0, followedIndex) + 1}/{props.items.length} · {shown.label}
      </span>
      <Button
        size="xs"
        variant="ghost"
        aria-label="다음 기다리는 일"
        data-pending-action-id={idOf(next)}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          setFollowedId(idOf(next));
          if (next.kind === "card") {
            props.onRevealCard(next.id);
          } else {
            props.onOpenThread(next.threadId);
          }
        }}
      >
        다음
      </Button>
    </span>
  );
}

/** Open cards and waiting threads share the composer's attention banner. */
export function pendingActionsBannerItem(
  input: PendingActionsInput,
): ComposerBannerStackItem | null {
  const { items } = input;
  const [only] = items;
  if (only === undefined) {
    return null;
  }
  return {
    id: input.id,
    variant: "info",
    priority: "attention",
    icon: <BellDotIcon className="text-primary" data-pending-actions-bar={items.length} />,
    title: items.length === 1 ? only.label : <PendingActionsStepper {...input} />,
    actions:
      items.length === 1 ? (
        <Button
          size="xs"
          variant="ghost"
          aria-label={`${only.label} ${only.kind === "card" ? "보기" : "열기"}`}
          data-pending-action-id={only.kind === "card" ? only.id : only.threadId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (only.kind === "card") {
              input.onRevealCard(only.id);
            } else {
              input.onOpenThread(only.threadId);
            }
          }}
        >
          {only.kind === "card" ? "보기" : "열기"}
        </Button>
      ) : null,
  };
}
