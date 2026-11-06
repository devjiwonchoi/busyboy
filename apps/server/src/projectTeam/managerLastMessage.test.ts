import { assert, describe, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  LAST_MESSAGE_PREVIEW_MAX_CHARS,
  managerLastMessage,
  previewText,
} from "./managerLastMessage.ts";

const message = (
  id: string,
  minute: number,
  fields: Partial<{
    role: "user" | "assistant" | "system";
    text: string;
    createdBy: "user" | "agent" | "system";
    streaming: boolean;
  }> = {},
) => ({
  id: MessageId.make(id),
  role: fields.role ?? "assistant",
  text: fields.text ?? `message ${id}`,
  createdBy: fields.createdBy ?? (fields.role === "user" ? "user" : "agent"),
  streaming: fields.streaming ?? false,
  createdAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 7, 9, minute)),
});

describe("managerLastMessage", () => {
  it("returns null for an empty chat", () => {
    assert.isNull(managerLastMessage([]));
  });

  it("picks the latest message from either side of the conversation", () => {
    assert.deepStrictEqual(
      managerLastMessage([
        message("a", 1, { text: "Earlier reply" }),
        message("b", 2, { role: "user", text: "What is left?" }),
      ]),
      { role: "user", text: "What is left?", at: "2026-11-07T09:02:00.000Z" },
    );
    assert.strictEqual(
      managerLastMessage([
        message("b", 2, { role: "user" }),
        message("c", 3, { text: "Two tasks." }),
      ])?.text,
      "Two tasks.",
    );
  });

  it("skips wakes, background compaction, streaming and empty messages", () => {
    const last = managerLastMessage([
      message("reply", 1, { text: "Latest real reply" }),
      message("wake", 2, { role: "user", createdBy: "system", text: "[Task #3 done]" }),
      message("card", 3, { role: "user", createdBy: "agent", text: "[Decision card] …" }),
      message("context-care:compact:turn-1", 4, { role: "user", text: "/compact" }),
      message("partial", 5, { streaming: true, text: "Half a sen" }),
      message("blank", 6, { text: "   " }),
      message("system", 7, { role: "system", text: "system note" }),
    ]);
    assert.strictEqual(last?.text, "Latest real reply");
  });
});

describe("previewText", () => {
  it("flattens markdown into one plain line", () => {
    assert.strictEqual(
      previewText("## Status\n\n- **#3** is [in review](https://x.y/3)\n- `pnpm test` passed\n"),
      "Status #3 is in review pnpm test passed",
    );
  });

  it("caps long text with an ellipsis", () => {
    const text = previewText("word ".repeat(100));
    assert.strictEqual(text.length, LAST_MESSAGE_PREVIEW_MAX_CHARS);
    assert.isTrue(text.endsWith("…"));
  });
});
