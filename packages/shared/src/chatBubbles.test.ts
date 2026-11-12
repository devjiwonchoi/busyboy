import { describe, expect, it } from "vite-plus/test";

import { isWideBubbleChunk, splitAssistantMarkdownIntoBubbles } from "./chatBubbles.js";

describe("splitAssistantMarkdownIntoBubbles", () => {
  it("returns no bubbles for empty text", () => {
    expect(splitAssistantMarkdownIntoBubbles("")).toEqual([]);
    expect(splitAssistantMarkdownIntoBubbles("\n\n  \n")).toEqual([]);
  });

  it("makes one bubble per paragraph", () => {
    expect(
      splitAssistantMarkdownIntoBubbles(
        "네, 고쳤어요.\n\n원인은 주소였어요.\n이제 돌아가요.\r\n\r\n끝.",
      ),
    ).toEqual(["네, 고쳤어요.", "원인은 주소였어요.\n이제 돌아가요.", "끝."]);
  });

  it("keeps a code fence whole, blank lines included", () => {
    const fence = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitAssistantMarkdownIntoBubbles(`Before.\n\n${fence}\n\nAfter.`)).toEqual([
      "Before.",
      fence,
      "After.",
    ]);
  });

  it("keeps an unclosed fence whole while the reply is still streaming", () => {
    expect(splitAssistantMarkdownIntoBubbles("Intro.\n\n~~~\nline one\n\nline two")).toEqual([
      "Intro.",
      "~~~\nline one\n\nline two",
    ]);
  });

  it("keeps a loose list together", () => {
    const list = "- one\n\n- two\n\n  more about two\n\n1. three";
    expect(splitAssistantMarkdownIntoBubbles(`${list}\n\nAfter the list.`)).toEqual([
      list,
      "After the list.",
    ]);
  });

  it("keeps tables and quotes whole", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    const quote = "> first\n\n> second";
    expect(splitAssistantMarkdownIntoBubbles(`${table}\n\n${quote}\n\nDone.`)).toEqual([
      table,
      quote,
      "Done.",
    ]);
  });

  it("attaches headings and lead-in paragraphs to what follows", () => {
    expect(
      splitAssistantMarkdownIntoBubbles(
        "## 결과\n\n다 됐어요.\n\n확인하려면:\n\n```\npnpm dev\n```",
      ),
    ).toEqual(["## 결과\n\n다 됐어요.", "확인하려면:\n\n```\npnpm dev\n```"]);
    expect(splitAssistantMarkdownIntoBubbles("결과\n===\n\n다 됐어요.\n\n---\n\n끝.")).toEqual([
      "결과\n===\n\n다 됐어요.",
      "끝.",
    ]);
  });

  it("keeps a reply with reference links or footnotes in one bubble", () => {
    const text =
      "See [the docs][docs].\n\nMore here.[^1]\n\n[docs]: https://example.com\n[^1]: A note.";
    expect(splitAssistantMarkdownIntoBubbles(text)).toEqual([text]);
  });

  it("still splits when a code block has a line that looks like a link definition", () => {
    const code = "```ts\nconst map = {\n  [Kind.A]: 1,\n};\n```";
    expect(splitAssistantMarkdownIntoBubbles(`First.\n\n${code}\n\nLast.`)).toEqual([
      "First.",
      code,
      "Last.",
    ]);
  });

  it("keeps a nested fence marker with a language inside its code block", () => {
    const code = "```md\n```js\n  [x]: 1\n```";
    expect(splitAssistantMarkdownIntoBubbles(`A.\n\n${code}\n\nB.`)).toEqual(["A.", code, "B."]);
  });

  it("drops a divider that follows a list", () => {
    expect(splitAssistantMarkdownIntoBubbles("- a\n- b\n\n* * *\n\nC.")).toEqual([
      "- a\n- b",
      "C.",
    ]);
  });
});

describe("isWideBubbleChunk", () => {
  it("marks code fences, tables and images as wide", () => {
    expect(isWideBubbleChunk("Run:\n\n```\npnpm dev\n```")).toBe(true);
    expect(isWideBubbleChunk("| a | b |\n| --- | :-: |\n| 1 | 2 |")).toBe(true);
    expect(isWideBubbleChunk("Just text.\n\n---\n\nMore text.")).toBe(false);
    expect(isWideBubbleChunk("- a list")).toBe(false);
    expect(isWideBubbleChunk("![chart](https://example.com/chart.png)")).toBe(true);
  });
});
