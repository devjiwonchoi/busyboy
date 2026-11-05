import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, type RefObject } from "react";

import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { useSideChatStore } from "../../sideChatStore";
import { toastManager } from "../ui/toast";

/** How long a new side chat's composer gets to become ready for a quote. */
export const SIDE_CHAT_CITATION_WAIT_MS = 10_000;
const RETRY_MS = 100;

type CitingComposer = {
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
};

/**
 * Adds the quotes sent with "Ask in side chat" to this side chat's composer. A side chat that
 * was just started may not take them yet, so this retries until its composer is ready.
 */
export function useSideChatCitationInbox(
  threadRef: ScopedThreadRef | null,
  composerRef: RefObject<CitingComposer | null>,
) {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const pending = useSideChatStore((state) =>
    threadKey ? state.pendingCitationsByThreadKey[threadKey] : undefined,
  );
  useEffect(() => {
    const ref = threadKey ? parseScopedThreadKey(threadKey) : null;
    if (!ref || !pending?.length) return;
    const startedAt = Date.now();
    let timer: number | undefined;
    const insertPending = () => {
      timer = undefined;
      const store = useSideChatStore.getState();
      for (const entry of pending) {
        // The selection's range may have been re-rendered since it was captured.
        const sourceAnchor =
          findAssistantCitationSourceAnchor(document, entry.citation) ?? entry.sourceAnchor;
        if (composerRef.current?.citeAssistantText(entry.citation, sourceAnchor)) {
          store.removeCitation(ref, entry);
          continue;
        }
        if (Date.now() - startedAt < SIDE_CHAT_CITATION_WAIT_MS) {
          timer = window.setTimeout(insertPending, RETRY_MS);
        } else {
          store.removeCitation(ref, entry);
          toastManager.add({
            type: "warning",
            title: "The side chat is not ready",
            description: "Select the text again once the side chat has loaded.",
          });
        }
        return;
      }
    };
    insertPending();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [composerRef, pending, threadKey]);
}
