import { describe, expect, it } from "vite-plus/test";

import {
  codexSupportsPredictionFork,
  normalizeCodexPromptSuggestion,
} from "./codexPromptSuggestion.ts";

describe("normalizeCodexPromptSuggestion", () => {
  it.each([
    ["run the tests", "run the tests"],
    ['"commit this"', "commit this"],
    ["Yes, tell me a short joke.", "Yes, tell me a short joke"],
    ["update app.ts too", "update app.ts too"],
    ["테스트 돌려줘", "테스트 돌려줘"],
  ])("keeps %j", (text, expected) => {
    expect(normalizeCodexPromptSuggestion(text)).toBe(expected);
  });

  it.each([
    ["nothing to predict", null],
    ["", null],
    [null, null],
    ["(no suggestion)", null],
    ["None", null],
    ["Let me run the tests", null],
    ["Thanks, looks good", null],
    ["should I commit?", null],
    ["Run the tests. Then commit.", null],
    ["run the tests\nthen commit", null],
    ["**run the tests**", null],
    ["please go ahead and run every single test in the whole repository now", null],
  ])("drops %j", (text, expected) => {
    expect(normalizeCodexPromptSuggestion(text)).toBe(expected);
  });
});

describe("codexSupportsPredictionFork", () => {
  it.each([
    ["Busyboy/0.164.0 (Mac OS 26.5.2; arm64) unknown (Busyboy; 0.1.0)", true],
    ["Busyboy/0.163.0-alpha.11.2 (Mac OS 26.5.2; arm64)", true],
    ["Busyboy/1.0.0", true],
    ["Busyboy/0.156.1", false],
    ["mock-codex-app-server", false],
  ])("reads %j", (userAgent, expected) => {
    expect(codexSupportsPredictionFork(userAgent)).toBe(expected);
  });
});
