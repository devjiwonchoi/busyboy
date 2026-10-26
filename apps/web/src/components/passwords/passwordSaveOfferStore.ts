import type { PasswordSaveDecision, PasswordSaveOffer } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { previewBridge } from "~/components/preview/previewBridge";

import { refreshSavedPasswordStatus } from "./savedPasswordStatusStore";

// The newest unanswered offer per preview tab. A later sign-in on the same tab
// replaces the earlier one, like Chrome's single save bubble.
let offersByTabId: Readonly<Record<string, PasswordSaveOffer>> = {};
const listeners = new Set<() => void>();
let unsubscribeBridge: (() => void) | null = null;

const setOffers = (next: Readonly<Record<string, PasswordSaveOffer>>) => {
  offersByTabId = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Listening starts with the first browser panel and stops with the last.
  unsubscribeBridge ??=
    previewBridge?.onPasswordSaveOffer((offer) => {
      setOffers({ ...offersByTabId, [offer.tabId]: offer });
    }) ?? null;
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
  const { [offer.tabId]: _answered, ...rest } = offersByTabId;
  setOffers(rest);
  await previewBridge?.respondToPasswordSaveOffer({
    offerId: offer.offerId,
    decision,
    username,
  });
  if (decision === "save") {
    await refreshSavedPasswordStatus();
  }
};
