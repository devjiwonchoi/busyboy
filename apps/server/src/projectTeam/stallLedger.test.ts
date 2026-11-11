import { assert, describe, it } from "@effect/vitest";
import type { ProjectTaskStallCause } from "@t3tools/contracts";
import { requestMessageProblems } from "@t3tools/shared/requestMessage";

import { holdConditionMet, liveStallCause, stallCard } from "./stallLedger.ts";

const live = {
  stage: "running" as const,
  hold: null,
  memoryHold: null,
  leadThreadId: "thread-lead" as never,
};

describe("stall rules", () => {
  it("counts only a lead that could move: not at work, not asking, not held", () => {
    const base = {
      task: live,
      leadBusy: false,
      openCards: 0,
      progressAtMs: 100,
      answeredAtMs: null,
    };
    assert.deepStrictEqual(liveStallCause(base), { cause: "no_progress", sinceMs: 100 });
    assert.isNull(liveStallCause({ ...base, leadBusy: true }));
    assert.isNull(liveStallCause({ ...base, openCards: 1 }));
    assert.isNull(liveStallCause({ ...base, task: { ...live, memoryHold: "paused" } }));
    assert.isNull(liveStallCause({ ...base, task: { ...live, stage: "in_review" } }));
    assert.deepStrictEqual(liveStallCause({ ...base, answeredAtMs: 200 }), {
      cause: "answered_idle",
      sinceMs: 200,
    });
  });

  it("meets a task condition when that task ends, a time when it comes, never a user one", () => {
    const stage = (stage: "running" | "done" | "cancelled") => () => stage;
    const onTask = { type: "task" as const, taskId: "task:a" as never };
    assert.isFalse(holdConditionMet(onTask, 0, stage("running")));
    assert.isTrue(holdConditionMet(onTask, 0, stage("done")));
    assert.isTrue(holdConditionMet(onTask, 0, stage("cancelled")));
    const at = "2026-11-11T09:00:00.000Z" as never;
    assert.isFalse(holdConditionMet({ type: "time", at }, Date.parse(at) - 1, () => undefined));
    assert.isTrue(holdConditionMet({ type: "time", at }, Date.parse(at), () => undefined));
    assert.isFalse(holdConditionMet({ type: "user", note: "고객 확인" }, 1e15, () => undefined));
  });

  it("writes every stall message in the messenger format", () => {
    const causes: ReadonlyArray<Exclude<ProjectTaskStallCause, "start_failed">> = [
      "no_progress",
      "answered_idle",
      "not_started",
      "hold_not_resumed",
    ];
    for (const cause of causes) {
      const card = stallCard({ cause, title: "로그인 리다이렉트 수정", minutes: 20 });
      assert.deepStrictEqual(requestMessageProblems(card.question, card.details), [], cause);
    }
  });
});
