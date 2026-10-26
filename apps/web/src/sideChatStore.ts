import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

type SideChatStoreState = {
  /** Each side chat's thread key, mapped to the key of the thread it was started from. */
  parentByThreadKey: Record<string, string>;
  register: (ref: ScopedThreadRef, parentRef: ScopedThreadRef) => void;
};

export const useSideChatStore = create<SideChatStoreState>()(
  persist(
    (set) => ({
      parentByThreadKey: {},
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
