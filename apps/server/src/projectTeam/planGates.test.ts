import { describe, expect, it } from "@effect/vitest";
import { emptyProjectTaskSpec, type ProjectTaskSpec } from "@t3tools/contracts";

import {
  PLAN_GATES,
  planCheckerBrief,
  planDepth,
  planGateGaps,
  planGatesPromptSection,
  requiredPlanGates,
} from "./planGates.ts";

const step = (id: string, dependsOn: ReadonlyArray<string> = []) => ({
  id,
  text: `Step ${id}`,
  done: false,
  subtaskId: null,
  criteria: ["c1"],
  dependsOn,
  doneWhen: "the test passes",
});

const light: ProjectTaskSpec = { ...emptyProjectTaskSpec(), todos: [step("t1")] };

describe("plan gates", () => {
  it("lists 11 gates in order, 8 of them for every plan", () => {
    expect(PLAN_GATES.map((gate) => gate.id)).toEqual([
      "problem",
      "why",
      "currentState",
      "nonGoals",
      "todos",
      "criteria",
      "traceability",
      "humanCheckpoints",
      "budget",
      "risks",
      "alternatives",
    ]);
    expect(requiredPlanGates("light")).toHaveLength(8);
    expect(requiredPlanGates("full")).toHaveLength(11);
    for (const gate of PLAN_GATES) {
      expect(gate.label.length).toBeGreaterThan(0);
      expect(gate.instruction.length).toBeGreaterThan(0);
      expect(gate.rubric.length).toBeGreaterThan(0);
      expect(gate.source.length).toBeGreaterThan(0);
    }
  });

  it("picks the full plan for medium and large tasks, and for a large plan", () => {
    expect(planDepth("small", light)).toBe("light");
    expect(planDepth("medium", light)).toBe("full");
    expect(planDepth("large", light)).toBe("full");
    // Ordered todos make a full plan even on a small task.
    expect(planDepth("small", { ...light, todos: [step("t1"), step("t2", ["t1"])] })).toBe("full");
  });

  it("names each empty required gate and a missing size", () => {
    const gaps = planGateGaps(light, null);
    expect(gaps[0]).toContain("size: set the task size with task_update(size)");
    expect(gaps.some((gap) => gap.startsWith('gate risks "위험" (risks)'))).toBe(true);
    const small = planGateGaps(light, "small");
    expect(small.map((gap) => gap.split(" ")[1])).toEqual([
      "problem",
      "why",
      "currentState",
      "nonGoals",
      "humanCheckpoints",
    ]);
  });

  it("teaches every gate in the prompt and briefs the checker on the required ones", () => {
    const section = planGatesPromptSection();
    for (const gate of PLAN_GATES) expect(section).toContain(`${gate.id} "${gate.label}"`);
    const brief = planCheckerBrief({
      taskId: "task-1",
      key: "BB-1",
      title: "Hello",
      specVersion: 3,
      round: 2,
      depth: "light",
    });
    expect(brief).toContain('task_spec_read(taskId: "task-1")');
    expect(brief).toContain("task_plan_check_set");
    expect(brief).toContain("specVersion: <the version you read, normally 3>");
    expect(brief).toContain("the server treats the check as stale");
    expect(brief).toContain("Check round 2");
    expect(brief).toContain('humanCheckpoints "사람 필요 지점"');
    expect(brief).not.toContain('budget "예산"');
  });
});
