import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { AssistantCitationSourceAnchor } from "./lib/assistantTextSelection";
import { resolveStorage } from "./lib/storage";

/** A quote waiting to be added to a side chat's composer once it is ready. */
export type PendingSideChatCitation = {
  readonly citation: AssistantCitation;
  readonly sourceAnchor: AssistantCitationSourceAnchor;
};

type SideChatStoreState = {
  /** Each side chat's thread key, mapped to the key of the thread it was started from. */
  parentByThreadKey: Record<string, string>;
  register: (ref: ScopedThreadRef, parentRef: ScopedThreadRef) => void;
  /** Quotes sent with "Ask in side chat", by side chat thread key. Not persisted. */
  pendingCitationsByThreadKey: Record<string, readonly PendingSideChatCitation[]>;
  queueCitation: (ref: ScopedThreadRef, pending: PendingSideChatCitation) => void;
  removeCitation: (ref: ScopedThreadRef, pending: PendingSideChatCitation) => void;
};

export const useSideChatStore = create<SideChatStoreState>()(
  persist(
    (set) => ({
      parentByThreadKey: {},
      pendingCitationsByThreadKey: {},
      queueCitation: (ref, pending) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          return {
            pendingCitationsByThreadKey: {
              ...state.pendingCitationsByThreadKey,
              [key]: [...(state.pendingCitationsByThreadKey[key] ?? []), pending],
            },
          };
        }),
      removeCitation: (ref, pending) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const { [key]: current = [], ...rest } = state.pendingCitationsByThreadKey;
          const remaining = current.filter((entry) => entry !== pending);
          return {
            pendingCitationsByThreadKey:
              remaining.length > 0 ? { ...rest, [key]: remaining } : rest,
          };
        }),
      register: (ref, parentRef) =>
        set((state) => ({
          parentByThreadKey: {
            ...state.parentByThreadKey,
            [scopedThreadKey(ref)]: scopedThreadKey(parentRef),
          },
        })),
    }),
    {
      name: "t3code:side-chat-threads:v2",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ parentByThreadKey: state.parentByThreadKey }),
    },
  ),
);

export function isSideChatThread(ref: ScopedThreadRef): boolean {
  return useSideChatStore.getState().parentByThreadKey[scopedThreadKey(ref)] !== undefined;
}

/** The side chats started from `parentRef`. */
export function readSideChatRefs(parentRef: ScopedThreadRef): ScopedThreadRef[] {
  const parentKey = scopedThreadKey(parentRef);
  return Object.entries(useSideChatStore.getState().parentByThreadKey).flatMap(
    ([threadKey, parent]) => {
      const ref = parent === parentKey ? parseScopedThreadKey(threadKey) : null;
      return ref === null ? [] : [ref];
    },
  );
}
