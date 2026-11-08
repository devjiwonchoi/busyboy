import type { LegendListRef } from "@legendapp/list/react";
import type { ThreadId } from "@t3tools/contracts";
import { BellDotIcon, ChevronDownIcon } from "lucide-react";

import type { PendingActionItem } from "../../state/projectTeam.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
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

/**
 * The banner above the composer for everything waiting on the user: open question cards
 * and other threads. It shows whether or not the card is on screen, in front of the
 * other banners. One item gets a "보기" button; several get a count and a list.
 */
export function pendingActionsBannerItem(input: {
  readonly id: string;
  readonly items: ReadonlyArray<PendingActionItem>;
  readonly onRevealCard: (cardId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem | null {
  const { items } = input;
  const [only] = items;
  if (only === undefined) return null;
  const itemId = (item: PendingActionItem) => (item.kind === "card" ? item.id : item.threadId);
  const follow = (item: PendingActionItem) =>
    item.kind === "card" ? input.onRevealCard(item.id) : input.onOpenThread(item.threadId);
  return {
    id: input.id,
    variant: "info",
    priority: "attention",
    icon: <BellDotIcon className="text-primary" data-pending-actions-bar={items.length} />,
    title: items.length === 1 ? only.label : `기다리는 일 ${items.length}개`,
    actions:
      items.length === 1 ? (
        <Button
          size="xs"
          variant="ghost"
          aria-label={`${only.label} ${only.kind === "card" ? "보기" : "열기"}`}
          data-pending-action-id={itemId(only)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => follow(only)}
        >
          {only.kind === "card" ? "보기" : "열기"}
        </Button>
      ) : (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost" aria-label="기다리는 일 목록" />}>
            목록
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" sideOffset={6} className="max-w-[min(22rem,90vw)]">
            {items.map((item) => (
              <MenuItem
                key={itemId(item)}
                data-pending-action-id={itemId(item)}
                onClick={() => follow(item)}
              >
                <span className="min-w-0 truncate">{item.label}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ),
  };
}
