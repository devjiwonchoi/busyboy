import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type ProjectTaskPlanCheck } from "@t3tools/contracts";
import { PLAN_GATE_LABELS, planCheckSummary, planGateSections } from "./planGates.ts";

const planCheck = (overrides: Partial<ProjectTaskPlanCheck> = {}): ProjectTaskPlanCheck => ({
  specVersion: 3,
  round: 2,
  status: "passed",
  requiredGates: ["problem", "risks"],
  verdicts: [
    { gate: "problem", pass: true, reason: "현재와 목표가 분명합니다." },
    { gate: "risks", pass: false, reason: "위험이 할 일과 이어지지 않습니다." },
  ],
  checker: {
    providerInstanceId: "claude",
    model: "claude-opus-4-7",
    threadId: ThreadId.make("checker-thread"),
    sameModelAsPlan: false,
  },
  startedAt: "2026-11-11T00:00:00.000Z",
  checkedAt: "2026-11-11T00:01:00.000Z",
  ask: { question: "플랜을 승인할까요?", context: {} as never },
  ...overrides,
});

describe("PLAN_GATE_LABELS", () => {
  it("lists every gate once in order", () => {
    expect(PLAN_GATE_LABELS.map((gate) => gate.label)).toEqual([
      "문제",
      "왜",
      "현재 상태",
      "안 하는 것",
      "할 일",
      "검증",
      "양방향 점검",
      "사람 필요 지점",
      "예산",
      "위험",
      "대안",
    ]);
  });
});

describe("planGateSections", () => {
  it("returns filled gate text in gate order, without 안 하는 것", () => {
    expect(
      planGateSections({
        alternatives: "  B안: 느려서 뺐습니다. ",
        problem: "지금은 느립니다.",
        nonGoals: "디자인 변경",
        why: "",
        budget: "   ",
      }),
    ).toEqual([
      { id: "problem", label: "문제", text: "지금은 느립니다." },
      { id: "alternatives", label: "대안", text: "B안: 느려서 뺐습니다." },
    ]);
  });

  it("returns nothing without a spec", () => {
    expect(planGateSections(undefined)).toEqual([]);
  });
});

describe("planCheckSummary", () => {
  it("summarizes the check for the card's version", () => {
    expect(planCheckSummary(planCheck(), 3)).toEqual({
      line: "검사 통과 · 2번째 확인 · Claude Opus 4.7",
      rows: [
        { label: "문제", pass: true, reason: "현재와 목표가 분명합니다." },
        { label: "위험", pass: false, reason: "위험이 할 일과 이어지지 않습니다." },
      ],
    });
  });

  it("says a failed check went up anyway and uses the given model label", () => {
    expect(planCheckSummary(planCheck({ status: "failed", round: 3 }), 3, () => "Opus")?.line).toBe(
      "검사 미통과 · 3번째 확인 · Opus",
    );
  });

  it("leaves out the model when no checker started", () => {
    expect(planCheckSummary(planCheck({ checker: null, round: 1 }), 3)?.line).toBe(
      "검사 통과 · 1번째 확인",
    );
  });

  it("notes quietly when the checker ran on the plan's own model", () => {
    const checker = { ...planCheck().checker!, sameModelAsPlan: true };
    expect(planCheckSummary(planCheck({ checker }), 3, () => "Opus")?.line).toBe(
      "검사 통과 · 2번째 확인 · Opus · 같은 모델",
    );
  });

  it("shows nothing for another version, a stale check or no check", () => {
    expect(planCheckSummary(planCheck(), 4)).toBeNull();
    expect(planCheckSummary(planCheck({ status: "stale" }), 3)).toBeNull();
    expect(planCheckSummary(null, 3)).toBeNull();
    expect(planCheckSummary(planCheck(), null)).toBeNull();
  });
});
