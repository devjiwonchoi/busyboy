import { describe, expect, it } from "@effect/vitest";

import { languageOfText, resolveUserLanguage } from "./userLanguage.ts";

describe("languageOfText", () => {
  it("tells languages apart by script", () => {
    expect(languageOfText("플랜을 한국어로 보여줘")).toBe("Korean");
    expect(languageOfText("PR 머지해줘")).toBe("Korean");
    expect(languageOfText("プランを見せて")).toBe("Japanese");
    expect(languageOfText("显示计划")).toBe("Chinese");
    expect(languageOfText("Show the plan.")).toBe("English");
    expect(languageOfText("https://x.test/1 → 👍")).toBe("English");
    expect(languageOfText("👍 123")).toBeNull();
  });

  it("does not count one quoted word of another script", () => {
    expect(languageOfText('Rename the "한" button.')).toBe("English");
  });
});

describe("resolveUserLanguage", () => {
  it("takes the request's language when it is not English", () => {
    expect(resolveUserLanguage("사이드바 정렬 고쳐줘", ["Fix it."])).toBe("Korean");
  });

  it("falls back to the user's own messages when the request is in English", () => {
    expect(
      resolveUserLanguage("Fix the sidebar order.", ["이거 고쳐줘", "Ok", "왜 영어로 보여?"]),
    ).toBe("Korean");
  });

  it("needs no rule for English", () => {
    expect(resolveUserLanguage("Fix the sidebar order.", ["Thanks", "이거"])).toBeNull();
    expect(resolveUserLanguage("Fix the sidebar order.", [])).toBeNull();
  });
});
