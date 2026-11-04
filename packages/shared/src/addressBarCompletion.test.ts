import { describe, expect, it } from "vite-plus/test";

import { inlineCompletionFor } from "./addressBarCompletion.ts";

const atEnd = { caretAtEnd: true };

describe("inlineCompletionFor", () => {
  it("completes the top match after the typed prefix, ignoring scheme and www", () => {
    const candidate = { url: "http://127.0.0.1:4000/welcome", origin: null };
    expect(inlineCompletionFor("127.0.0.1:4000/we", candidate, atEnd)).toEqual({
      url: "http://127.0.0.1:4000/welcome",
      suffix: "lcome",
    });
    expect(
      inlineCompletionFor("Exa", { url: "https://www.example.com/docs", origin: null }, atEnd),
    ).toEqual({ url: "https://www.example.com/docs", suffix: "mple.com/docs" });
  });

  it("prefers the origin once it has been visited twice", () => {
    const candidate = (visitCount: number) => ({
      url: "https://github.com/org/repo",
      origin: { url: "https://github.com/", visitCount },
    });
    expect(inlineCompletionFor("gi", candidate(2), atEnd)?.url).toBe("https://github.com/");
    expect(inlineCompletionFor("gi", candidate(1), atEnd)?.url).toBe("https://github.com/org/repo");
    // Past the origin, the full URL is the only completion left.
    expect(inlineCompletionFor("github.com/o", candidate(5), atEnd)?.suffix).toBe("rg/repo");
  });

  it("does not complete short input, non-prefix matches, search text, or mid-text carets", () => {
    const candidate = { url: "https://github.com/", origin: null };
    expect(inlineCompletionFor("g", candidate, atEnd)).toBeNull();
    expect(inlineCompletionFor("hub", candidate, atEnd)).toBeNull();
    expect(inlineCompletionFor("git hub", candidate, atEnd)).toBeNull();
    expect(inlineCompletionFor("gi", candidate, { caretAtEnd: false })).toBeNull();
    expect(inlineCompletionFor("gi", null, atEnd)).toBeNull();
    expect(inlineCompletionFor("github.com/", candidate, atEnd)).toBeNull();
  });
});
