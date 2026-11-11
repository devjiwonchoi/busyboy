import { isWideBubbleChunk, splitAssistantMarkdownIntoBubbles } from "@t3tools/shared/chatBubbles";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

export interface AssistantBubble {
  readonly text: string;
  /** Holds a code block or table, so it takes the full row width. */
  readonly wide: boolean;
}

/** One messenger bubble per paragraph, split by the same rule as the web app. */
export function resolveAssistantBubbles(markdown: string): ReadonlyArray<AssistantBubble> {
  return splitAssistantMarkdownIntoBubbles(markdown).map((text) => ({
    text,
    wide: isWideBubbleChunk(text),
  }));
}

/** The first assistant message after each user message; it carries the sender line. */
export function replyStartAssistantMessageIds(
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  let awaitingReply = true;
  for (const entry of feed) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      awaitingReply = true;
    } else if (entry.message.role === "assistant" && awaitingReply) {
      ids.add(entry.message.id);
      awaitingReply = false;
    }
  }
  return ids;
}
