import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { replyStartAssistantMessageIds, resolveAssistantBubbles } from "./assistant-bubbles";

const entry = (id: string, role: "user" | "assistant"): ThreadFeedEntry =>
  ({ type: "message", id, message: { id, role } }) as unknown as ThreadFeedEntry;

describe("resolveAssistantBubbles", () => {
  it("splits a reply into paragraph bubbles and widens code and tables", () => {
    expect(
      resolveAssistantBubbles(
        "네, 고쳤어요.\n\n확인하려면:\n\n```\npnpm dev\n```\n\n| a |\n| - |\n| 1 |",
      ),
    ).toEqual([
      { text: "네, 고쳤어요.", wide: false },
      { text: "확인하려면:\n\n```\npnpm dev\n```", wide: true },
      { text: "| a |\n| - |\n| 1 |", wide: true },
    ]);
  });
});

describe("replyStartAssistantMessageIds", () => {
  it("marks only the first assistant message of each reply", () => {
    const feed = [
      entry("a0", "assistant"),
      entry("u1", "user"),
      entry("a1", "assistant"),
      entry("a2", "assistant"),
      entry("u2", "user"),
      entry("a3", "assistant"),
    ];
    expect([...replyStartAssistantMessageIds(feed)]).toEqual(["a0", "a1", "a3"]);
  });
});
