import { describe, expect, it } from "@effect/vitest";
import { emptyProjectTaskSpec, type ProjectTaskSpec } from "@t3tools/contracts";

import {
  isFullPlan,
  planReadinessGaps,
  specLinkProblems,
  unprovenCriteria,
} from "./planReadiness.ts";

const step = (
  id: string,
  criteria: ReadonlyArray<string>,
  dependsOn: ReadonlyArray<string> = [],
) => ({
  id,
  text: `Step ${id}`,
  done: false,
  subtaskId: null,
  criteria,
  dependsOn,
  doneWhen: "the test passes",
});

const ready: ProjectTaskSpec = {
  ...emptyProjectTaskSpec(),
  summary: "There is no hello script yet. Running hello.sh will print hello.",
  goal: "hello.sh prints hello.",
  criteria: [{ id: "c1", text: "It prints hello", provenBy: "a unit test", evidence: null }],
  todos: [step("t1", ["c1"])],
  files: [{ path: "hello.sh", change: "new", why: "the script", todos: ["t1"] }],
};

describe("planReadinessGaps", () => {
  it("passes a complete light plan", () => {
    expect(planReadinessGaps(ready)).toEqual([]);
    expect(isFullPlan(ready)).toBe(false);
  });

  it("names every missing part of an empty plan", () => {
    expect(planReadinessGaps(emptyProjectTaskSpec("Add hello.sh."))).toEqual([
      "summary: 2-4 sentences in your own words: what is wrong today and what the user sees when it is done",
      "goal: describe the end state the user will see",
      "criteria: add at least one success criterion",
      "todos: add the steps that build the criteria",
      "files: list every file the plan adds, changes or deletes, and why",
    ]);
  });

  it("needs a way to prove each criterion", () => {
    const spec = { ...ready, criteria: [{ ...ready.criteria[0]!, provenBy: " " }] };
    expect(planReadinessGaps(spec)).toEqual(["criteria c1: say how each is proven (provenBy)"]);
  });

  it("checks coverage both ways: every criterion built, every todo serving one", () => {
    const spec: ProjectTaskSpec = {
      ...ready,
      criteria: [
        ...ready.criteria,
        { id: "c2", text: "It exits 0", provenBy: "a unit test", evidence: null },
      ],
      todos: [step("t1", ["c1"]), step("t2", [])],
    };
    expect(planReadinessGaps(spec)).toEqual([
      "criteria c2: no todo builds them (list them in a todo's criteria)",
      "todos t2: serve no criterion (link them, or drop them if they are delivery steps the stages already cover)",
    ]);
  });

  it("asks a large plan for a flow diagram", () => {
    const spec: ProjectTaskSpec = {
      ...ready,
      todos: [step("t1", ["c1"]), step("t2", ["c1"], ["t1"])],
    };
    expect(isFullPlan(spec)).toBe(true);
    expect(planReadinessGaps(spec)).toEqual([
      "flow: this plan is large (4+ todos, 6+ files, or ordered todos), so add a Mermaid diagram of the behavior",
    ]);
    expect(planReadinessGaps({ ...spec, flow: "flowchart LR\n  A --> B" })).toEqual([]);
  });

  it("asks a UI plan for a prototype or a reason to skip it", () => {
    const spec: ProjectTaskSpec = {
      ...ready,
      files: [{ path: "apps/web/src/Hello.tsx", change: "new", why: "the view", todos: ["t1"] }],
    };
    expect(planReadinessGaps(spec)).toEqual([
      "prototype: the plan changes UI, so add an HTML mockup of the end state, or say why not in prototypeWaiver",
    ]);
    expect(planReadinessGaps({ ...spec, prototype: "<main>Hello</main>" })).toEqual([]);
    expect(planReadinessGaps({ ...spec, prototypeWaiver: "Copy change only." })).toEqual([]);
  });

  it("needs a done-when line on every todo", () => {
    const spec: ProjectTaskSpec = { ...ready, todos: [{ ...step("t1", ["c1"]), doneWhen: "" }] };
    expect(planReadinessGaps(spec)).toEqual([
      "todos t1: say how the user can tell each is done (doneWhen)",
    ]);
  });
});

describe("specLinkProblems", () => {
  it("finds links to ids the spec does not have", () => {
    const spec: ProjectTaskSpec = {
      ...ready,
      todos: [step("t1", ["c1", "c9"], ["t1", "t7"])],
      files: [{ path: "hello.sh", change: "new", why: "", todos: ["t3"] }],
    };
    expect(specLinkProblems(spec)).toEqual([
      "todo t1 lists unknown criteria: c9",
      "todo t1 depends on unknown todos: t1, t7",
      "file hello.sh lists unknown todos: t3",
    ]);
  });
});

describe("unprovenCriteria", () => {
  it("lists criteria without evidence", () => {
    expect(unprovenCriteria(ready)).toEqual(["c1"]);
    expect(
      unprovenCriteria({
        ...ready,
        criteria: [{ ...ready.criteria[0]!, evidence: "test passed" }],
      }),
    ).toEqual([]);
  });
});
