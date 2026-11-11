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
  problem: "Nothing prints hello today; after this, hello.sh prints it.",
  why: "The user asked for it; without it the demo has no output. Asked whether it needs flags: no.",
  currentState: "No hello.sh exists in the repository root (ls shows none).",
  nonGoals: "A Windows script: the demo runs on macOS only.",
  humanCheckpoints: "None: no sign-in, tokens or payment are involved.",
};

/** The gates only full plans need. */
const fullGates = {
  budget: "One hour; drop the color output if it runs over.",
  risks: "It fails if the shell is not bash: t1 uses POSIX sh only.",
  alternatives: "A Node script: rejected, it needs a runtime.",
};

describe("planReadinessGaps", () => {
  it("passes a complete light plan", () => {
    expect(planReadinessGaps(ready, "small")).toEqual([]);
    expect(isFullPlan(ready)).toBe(false);
  });

  it("names every missing part of an empty plan", () => {
    const emptyGates = ["problem", "why", "currentState", "nonGoals", "humanCheckpoints"].map(
      (id) => expect.stringMatching(new RegExp(`^gate ${id} "`)),
    );
    expect(planReadinessGaps(emptyProjectTaskSpec("Add hello.sh."), "small")).toEqual([
      "summary: 2-4 sentences in your own words: what is wrong today and what the user sees when it is done",
      "goal: describe the end state the user will see",
      "criteria: add at least one success criterion",
      "todos: add the steps that build the criteria",
      "files: list every file the plan adds, changes or deletes, and why",
      ...emptyGates,
    ]);
  });

  it("needs a way to prove each criterion", () => {
    const spec = { ...ready, criteria: [{ ...ready.criteria[0]!, provenBy: " " }] };
    expect(planReadinessGaps(spec, "small")).toEqual([
      "criteria c1: say how each is proven (provenBy)",
    ]);
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
    expect(planReadinessGaps(spec, "small")).toEqual([
      "criteria c2: no todo builds them (list them in a todo's criteria)",
      "todos t2: serve no criterion (link them, or drop them if they are delivery steps the stages already cover)",
    ]);
  });

  it("asks a large plan for a flow diagram", () => {
    const spec: ProjectTaskSpec = {
      ...ready,
      ...fullGates,
      todos: [step("t1", ["c1"]), step("t2", ["c1"], ["t1"])],
    };
    expect(isFullPlan(spec)).toBe(true);
    expect(planReadinessGaps(spec, "small")).toEqual([
      "flow: this plan is large (4+ todos, 6+ files, or ordered todos), so add a Mermaid diagram of the behavior",
    ]);
    expect(planReadinessGaps({ ...spec, flow: "flowchart LR\n  A --> B" }, "small")).toEqual([]);
  });

  it("asks a UI plan for a prototype or a reason to skip it", () => {
    const spec: ProjectTaskSpec = {
      ...ready,
      files: [{ path: "apps/web/src/Hello.tsx", change: "new", why: "the view", todos: ["t1"] }],
    };
    expect(planReadinessGaps(spec, "small")).toEqual([
      "prototype: the plan changes UI, so add an HTML mockup of the end state, or say why not in prototypeWaiver",
    ]);
    expect(planReadinessGaps({ ...spec, prototype: "<main>Hello</main>" }, "small")).toEqual([]);
    expect(planReadinessGaps({ ...spec, prototypeWaiver: "Copy change only." }, "small")).toEqual(
      [],
    );
  });

  it("sends back a light plan with an empty gate", () => {
    expect(planReadinessGaps({ ...ready, why: " " }, "small")).toEqual([
      expect.stringContaining('gate why "왜" (why): Say who asked'),
    ]);
  });

  it("needs the budget, risks and alternatives only in a full plan", () => {
    // A small task's light plan passes without them.
    expect(planReadinessGaps(ready, "small")).toEqual([]);
    const gaps = planReadinessGaps(ready, "medium");
    expect(gaps.map((gap) => gap.split(" ")[1])).toEqual(["budget", "risks", "alternatives"]);
    expect(planReadinessGaps({ ...ready, ...fullGates, risks: "" }, "large")).toEqual([
      expect.stringContaining('gate risks "위험" (risks)'),
    ]);
  });

  it("needs the task size", () => {
    expect(planReadinessGaps(ready, null)).toEqual([
      expect.stringContaining("size: set the task size with task_update(size)"),
      ...["budget", "risks", "alternatives"].map((id) =>
        expect.stringMatching(new RegExp(`^gate ${id} "`)),
      ),
    ]);
  });

  it("needs a done-when line on every todo", () => {
    const spec: ProjectTaskSpec = { ...ready, todos: [{ ...step("t1", ["c1"]), doneWhen: "" }] };
    expect(planReadinessGaps(spec, "small")).toEqual([
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
