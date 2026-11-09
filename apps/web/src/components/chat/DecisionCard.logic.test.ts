import { describe, expect, it } from "vite-plus/test";
import {
  decisionQuestionPresentation,
  parseDecisionOption,
  splitDecisionQuestion,
} from "./DecisionCard.logic";

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

describe("decisionQuestionPresentation", () => {
  const question =
    "비용 보정 실험은 5개 중 2개가 성공하고 3개가 실패했습니다. 현재까지 약 $6가 들었고 추가 실행의 상한은 $15입니다. 실패 원인이 아직 불확실하므로 지금 결과로 판단하기보다 로그를 확인한 뒤 재실행 범위를 정하는 것을 추천합니다. 이 조건으로 계속 진행할까요?";

  it("keeps a long legacy paragraph intact under a neutral task title", () => {
    expect(
      decisionQuestionPresentation({ question, action: null, taskTitle: "비용 보정" }),
    ).toEqual({ headline: "비용 보정에 대한 결정", context: question });
  });

  it("uses an explicit action and retains the entire original question", () => {
    expect(
      decisionQuestionPresentation({
        question,
        action: "$15 상한으로 비용 보정 실험을 다시 실행합니다.",
        taskTitle: "비용 보정",
      }),
    ).toEqual({ headline: "$15 상한으로 비용 보정 실험을 다시 실행합니다.", context: question });
  });

  it("preserves the short legacy headline and markdown context", () => {
    expect(
      decisionQuestionPresentation({
        question: "**진행할까요?**\n\n약 $6 사용, 상한 $15",
        action: undefined,
        taskTitle: "비용 보정",
      }),
    ).toEqual({ headline: "진행할까요?", context: "약 $6 사용, 상한 $15" });
  });
});

describe("parseDecisionOption", () => {
  it.each([
    ["Guard — Today (Recommended)", "Guard", "Today", true],
    ["Guard (recommended) – Today", "Guard", "Today", true],
    ["Re-run", "Re-run", null, false],
    ["Guard — Today — Later", "Guard", "Today — Later", false],
    ["Guard (RECOMMENDED)", "Guard", null, true],
    [
      "A (추천): 5개 중 2개 성공, 3개 실패; 약 $6 사용, 상한 $15",
      "A",
      "5개 중 2개 성공, 3개 실패; 약 $6 사용, 상한 $15",
      true,
    ],
    ["다시 실행 (추천)", "다시 실행", null, true],
  ])("preserves %j as the answer", (raw, label, tradeoff, recommended) => {
    expect(parseDecisionOption(raw)).toEqual({ value: raw, label, tradeoff, recommended });
  });

  it("preserves a long option without a short explicit label", () => {
    const raw = "추가 실험의 결과는 불확실합니다. ".repeat(8) + "상한: $15";
    expect(parseDecisionOption(raw)).toEqual({
      value: raw,
      label: raw,
      tradeoff: null,
      recommended: false,
    });
  });
});
