import type { ProjectDecisionCard } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { BellDotIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isOpenDecisionCard } from "../../state/projectTeam.logic";
import { Button } from "../ui/button";

const HIGHLIGHT_MS = 1800;
const REVEAL_ATTEMPTS = 30;

export function pendingActionsLabel(count: number): string {
  return count === 1 ? "1 action waiting" : `${count} actions waiting`;
}

function cardElement(scrollNode: Element, cardId: string): HTMLElement | null {
  return scrollNode.querySelector<HTMLElement>(`[data-decision-card="${CSS.escape(cardId)}"]`);
}

/** True when part of the element shows inside the scroll viewport. */
function isInView(scrollNode: Element, element: HTMLElement): boolean {
  const viewport = scrollNode.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

/** The oldest waiting card that is out of view; the timeline unmounts rows far off screen. */
function firstHiddenCard(
  scrollNode: Element | null,
  waiting: ReadonlyArray<ProjectDecisionCard>,
): ProjectDecisionCard | null {
  if (scrollNode === null) return waiting[0] ?? null;
  for (const card of waiting) {
    const element = cardElement(scrollNode, card.item.id);
    if (element === null || !isInView(scrollNode, element)) return card;
  }
  return null;
}

function flash(element: HTMLElement) {
  element.dataset.decisionCardHighlighted = "true";
  window.setTimeout(() => {
    delete element.dataset.decisionCardHighlighted;
  }, HIGHLIGHT_MS);
}

/**
 * A pill like "Scroll to end" that counts the question cards waiting on the user. It shows
 * while one of them is out of view; a click scrolls to the oldest of those and flashes it.
 */
export function PendingActionsNudge({
  cards,
  listRef,
  onNavigate,
}: {
  /** The thread's cards, oldest first; closed ones are ignored. */
  cards: ReadonlyArray<ProjectDecisionCard>;
  listRef: React.RefObject<LegendListRef | null>;
  /** Called before scrolling, so the timeline stops following the end. */
  onNavigate: () => void;
}) {
  const waiting = cards.filter(isOpenDecisionCard);
  const [target, setTarget] = useState<ProjectDecisionCard | null>(null);
  const waitingKey = waiting.map((card) => card.item.id).join("\0");

  // Re-check on scroll and resize: a card scrolled into view needs no nudge.
  useEffect(() => {
    if (waitingKey === "") {
      setTarget(null);
      return;
    }
    const scrollNode = listRef.current?.getScrollableNode() ?? null;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setTarget(firstHiddenCard(listRef.current?.getScrollableNode() ?? null, waiting));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    scrollNode?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Rows mount and resize after the list scrolls; observe the list's subtree.
    const observer = new MutationObserver(schedule);
    if (scrollNode) observer.observe(scrollNode, { childList: true, subtree: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scrollNode?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `waiting` is rebuilt every render; its ids are the identity.
  }, [listRef, waitingKey]);

  if (waiting.length === 0 || target === null) return null;

  const reveal = () => {
    const list = listRef.current;
    if (!list) return;
    const cardId = target.item.id;
    onNavigate();
    const index = list.getState().indexByKey(`decision-card:${cardId}`);
    if (index !== undefined) {
      void list.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 24 });
    }
    // The row may mount only once the list reaches it; flash it when it shows up.
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
  };

  return (
    <Button
      aria-label={`${pendingActionsLabel(waiting.length)}. Show the first one`}
      data-pending-actions-nudge={waiting.length}
      onPointerDown={(event) => event.preventDefault()}
      onClick={reveal}
      className="pointer-events-auto"
      size="xs"
      variant="glass"
    >
      <BellDotIcon className="size-3.5 text-primary" />
      {pendingActionsLabel(waiting.length)}
    </Button>
  );
}
