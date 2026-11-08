import type { ProjectDecisionCard, ProjectWaitingThread, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act } from "react";
import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { pendingActionItems } from "../../state/projectTeam.logic";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { pendingActionsBannerItem, revealDecisionCard } from "./PendingActionsBar";

/** The composer's banner stack with the pending bar, as ChatView builds it. */
export function PendingBar(props: {
  cards: ReadonlyArray<ProjectDecisionCard>;
  waitingThreads?: ReadonlyArray<ProjectWaitingThread>;
  listRef: React.RefObject<LegendListRef | null>;
  onOpenThread?: (threadId: ThreadId) => void;
  otherItems?: ReadonlyArray<ComposerBannerStackItem>;
}) {
  const bar = pendingActionsBannerItem({
    id: "pending-actions",
    items: pendingActionItems({ cards: props.cards, waitingThreads: props.waitingThreads ?? [] }),
    onRevealCard: (cardId) => revealDecisionCard(props.listRef.current, cardId),
    onOpenThread: props.onOpenThread ?? (() => {}),
  });
  return (
    <div data-testid="composer-banners" style={{ width: "100%", maxWidth: 720, margin: "0 auto" }}>
      <ComposerBannerStack items={[...(bar ? [bar] : []), ...(props.otherItems ?? [])]} />
    </div>
  );
}

/** The bar's icon carries the count; null while nothing waits. */
export const pendingBarIcon = () =>
  document.querySelector<HTMLElement>("[data-pending-actions-bar]");

/** The banner row holding the bar, for its title text. */
export function pendingBar(): HTMLElement | null {
  const icon = pendingBarIcon();
  return icon?.closest<HTMLElement>("[role=alert]") ?? null;
}

/** Taps the bar's button for one item, or picks the item from its list. */
export async function followPendingAction(id: string) {
  const direct = document.querySelector<HTMLElement>(
    `button[data-pending-action-id="${CSS.escape(id)}"]`,
  );
  if (direct) {
    await act(async () => userEvent.click(direct));
    return;
  }
  const trigger = document.querySelector<HTMLElement>('[aria-label="기다리는 일 목록"]');
  expect(trigger, "pending list button").not.toBeNull();
  await act(async () => userEvent.click(trigger!));
  const item = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      `[role=menuitem][data-pending-action-id="${CSS.escape(id)}"]`,
    );
    expect(element, `menu item ${id}`).not.toBeNull();
    return element!;
  });
  await act(async () => userEvent.click(item));
}
