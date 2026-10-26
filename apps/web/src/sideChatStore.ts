import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

type SideChatStoreState = {
  /** Threads started as side chats, which stay out of the thread list. */
  threadKeys: Record<string, true>;
  register: (ref: ScopedThreadRef) => void;
};

export const useSideChatStore = create<SideChatStoreState>()(
  persist(
    (set) => ({
      threadKeys: {},
      register: (ref) =>
        set((state) => ({ threadKeys: { ...state.threadKeys, [scopedThreadKey(ref)]: true } })),
    }),
    {
      name: "t3code:side-chat-threads:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ threadKeys: state.threadKeys }),
    },
  ),
);
