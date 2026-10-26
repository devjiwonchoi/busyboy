import type { PasswordSaveDecision, PasswordSaveOffer } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { previewBridge } from "~/components/preview/previewBridge";

import { refreshSavedPasswordStatus } from "./savedPasswordStatusStore";

// The newest unanswered offer per preview tab. A later sign-in on the same tab
// replaces the earlier one, like Chrome's single save bubble.
let offersByTabId: Readonly<Record<string, PasswordSaveOffer>> = {};
const listeners = new Set<() => void>();
let unsubscribeBridge: (() => void) | null = null;

const withoutTab = (tabId: string) => {
  const { [tabId]: _removed, ...rest } = offersByTabId;
  return rest;
};

const setOffers = (next: Readonly<Record<string, PasswordSaveOffer>>) => {
  offersByTabId = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Listening starts with the first browser panel and stops with the last.
  if (unsubscribeBridge === null && previewBridge) {
    const stopOffers = previewBridge.onPasswordSaveOffer((offer) => {
      setOffers({ ...offersByTabId, [offer.tabId]: offer });
    });
    const stopWithdrawals = previewBridge.onPasswordSaveOfferWithdrawn((tabId) => {
      setOffers(withoutTab(tabId));
    });
    unsubscribeBridge = () => {
      stopOffers();
      stopWithdrawals();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
    }
  };
};

export function usePasswordSaveOffer(tabId: string | null): PasswordSaveOffer | null {
  return useSyncExternalStore(subscribe, () =>
    tabId === null ? null : (offersByTabId[tabId] ?? null),
  );
}

export const respondToPasswordSaveOffer = async ({
  offer,
  decision,
  username,
}: {
  readonly offer: PasswordSaveOffer;
  readonly decision: PasswordSaveDecision;
  readonly username: string;
}): Promise<void> => {
  setOffers(withoutTab(offer.tabId));
  await previewBridge?.respondToPasswordSaveOffer({
    offerId: offer.offerId,
    decision,
    username,
  });
  if (decision === "save") {
    await refreshSavedPasswordStatus();
  }
};
