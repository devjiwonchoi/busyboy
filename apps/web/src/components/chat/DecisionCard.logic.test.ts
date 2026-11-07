import { describe, expect, it } from "vite-plus/test";
import { parseDecisionOption, splitDecisionQuestion } from "./DecisionCard.logic";

describe("splitDecisionQuestion", () => {
  it.each([
    ["\n\nQuestion?\n\nContext\n", "Question?", "Context"],
    ["Question?", "Question?", ""],
    ["", "", ""],
    ["#12 Fix login: 리드 작업이 실패했어요", "#12 Fix login: 리드 작업이 실패했어요", ""],
    ["### Question?", "Question?", ""],
    ["Choose **one** or __two__", "Choose one or two", ""],
    ["Choose *one* or _two_", "Choose one or two", ""],
    ["Fix `redirect()`?", "Fix redirect()?", ""],
    ["Rename user_id and file_name?", "Rename user_id and file_name?", ""],
    ["Is 2 * 3 * 4 ok?", "Is 2 * 3 * 4 ok?", ""],
    ["Drop `__init__`?", "Drop __init__?", ""],
    ["Read [the plan](https://example.com)?", "Read the plan?", ""],
    ["**Question**\n\n**Context**", "Question", "**Context**"],
  ])("splits %j into a plain title and markdown context", (text, headline, context) => {
    expect(splitDecisionQuestion(text)).toEqual({ headline, context });
  });
});

describe("parseDecisionOption", () => {
  it.each([
    ["Guard — Today (Recommended)", "Guard", "Today", true],
    ["Guard (recommended) – Today", "Guard", "Today", true],
    ["Re-run", "Re-run", null, false],
    ["Guard — Today — Later", "Guard", "Today — Later", false],
    ["Guard (RECOMMENDED)", "Guard", null, true],
  ])("preserves %j as the answer", (raw, label, tradeoff, recommended) => {
    expect(parseDecisionOption(raw)).toEqual({ value: raw, label, tradeoff, recommended });
  });
});
