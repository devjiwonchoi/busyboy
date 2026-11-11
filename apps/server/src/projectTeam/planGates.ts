/**
 * The plan gates: BusyBoy's fixed procedure every task plan passes before the user sees
 * its approval card. The server refuses a plan with an empty required gate; a separate
 * checker session, on a different model when one is set up, then judges each gate.
 */
import type { ProjectTaskSize, ProjectTaskSpec } from "@t3tools/contracts";

/** A plan this big needs the full form, and a flow diagram. */
const FULL_PLAN_TODOS = 4;
const FULL_PLAN_FILES = 6;

/** Larger plans (many steps or files, or ordered steps) need the full form. */
export function isFullPlan(spec: ProjectTaskSpec): boolean {
  return (
    spec.todos.length >= FULL_PLAN_TODOS ||
    spec.files.length >= FULL_PLAN_FILES ||
    spec.todos.some((todo) => todo.dependsOn.length > 0)
  );
}

/** Light plans (small tasks) need the `all` gates; full plans need every gate. */
export type PlanDepth = "light" | "full";

/** Spec text fields a gate needs filled. */
export type PlanGateTextField =
  | "problem"
  | "why"
  | "currentState"
  | "nonGoals"
  | "humanCheckpoints"
  | "budget"
  | "risks"
  | "alternatives";

export interface PlanGate {
  readonly id: string;
  /** Short Korean label the user sees. */
  readonly label: string;
  /** The spec fields the gate reads. */
  readonly fields: ReadonlyArray<string>;
  /** The text field the server refuses empty; null when the gate is checked structurally. */
  readonly requiredText: PlanGateTextField | null;
  readonly depth: "all" | "full";
  /** What the lead writes, in one or two lines. */
  readonly instruction: string;
  /** How the checker judges it. */
  readonly rubric: string;
  /** Where the practice comes from. */
  readonly source: string;
}

export const PLAN_GATES: ReadonlyArray<PlanGate> = [
  {
    id: "problem",
    label: "문제",
    fields: ["problem", "summary"],
    requiredText: "problem",
    depth: "all",
    instruction:
      "Write the current state, the desired state, and how you will measure the change. The user approves from the summary: 2-4 plain sentences in your own words on what is wrong today and what the user sees when it is done.",
    rubric:
      "Pass only if problem names a concrete current state and a desired state with a measurable difference, and summary says plainly what is wrong today and what the user sees when it is done. Fail vague goals such as 'improve' or 'clean up'.",
    source:
      "A3 report (https://www.lean.org/lexicon-terms/a3-report/); Amazon Working Backwards (press release first)",
  },
  {
    id: "why",
    label: "왜",
    fields: ["why"],
    requiredText: "why",
    depth: "all",
    instruction:
      "Say who asked, what is lost without it, and at least one requirement you questioned (and what you concluded).",
    rubric:
      "Pass only if why names who asked, what is lost if it is not done, and at least one requirement that was questioned with its conclusion.",
    source: "A3 report, Background (https://www.lean.org/lexicon-terms/a3-report/)",
  },
  {
    id: "currentState",
    label: "현재 상태",
    fields: ["currentState"],
    requiredText: "currentState",
    depth: "all",
    instruction:
      "Give evidence of today's state: code paths, data, a repro. For a bug, separate the symptom from the root cause and give a measured or reproduced baseline.",
    rubric:
      "Pass only if currentState cites real evidence (file paths, functions, data or a repro). For a bug or problem, it must separate symptom from root cause and give a measured or reproduced baseline; a guess does not pass.",
    source: "5 Whys (https://www.lean.org/lexicon-terms/5-whys/)",
  },
  {
    id: "nonGoals",
    label: "안 하는 것",
    fields: ["nonGoals"],
    requiredText: "nonGoals",
    depth: "all",
    instruction:
      "List things that could reasonably be goals but are dropped, each with its reason.",
    rubric:
      "Pass only if each non-goal is something a reader could reasonably expect in scope, with a reason it is dropped. Fail filler such as 'no unrelated changes'.",
    source:
      "Design Docs at Google (https://www.industrialempathy.com/posts/design-docs-at-google/)",
  },
  {
    id: "todos",
    label: "할 일",
    fields: ["todos"],
    requiredText: null,
    depth: "all",
    instruction:
      'The user approves from the todos too: each is one short plain step with a doneWhen saying how the user can tell it is done (a check they could see or run, not "implemented"). Ordered ones use dependsOn, the rest can run in parallel. No overlap, and together they cover the goal. No delivery todos such as "open a PR" or "run the tests": the stages already are delivery.',
    rubric:
      "Pass only if every todo is a concrete next action with a checkable doneWhen, ordering is expressed with dependsOn, todos do not overlap, and together they cover the goal (MECE).",
    source: "MECE (Barbara Minto, The Pyramid Principle)",
  },
  {
    id: "criteria",
    label: "검증",
    fields: ["criteria"],
    requiredText: null,
    depth: "all",
    instruction:
      "Give each criterion an id (c1, c2, ...) and text naming a condition or trigger and an observable result (When X, the user sees Y); provenBy names the proof (a named test, a check you run, a screenshot). Leave evidence empty; you record it while you work.",
    rubric:
      "Pass only if every criterion states a condition or trigger and an observable result, and provenBy names a specific proof (a named test, a command, a screenshot). Fail untestable wording such as 'works well'.",
    source: "EARS (Mavin et al., RE'09); Kiro specs (https://kiro.dev/docs/specs/feature-specs/)",
  },
  {
    id: "traceability",
    label: "양방향 점검",
    fields: ["todos.criteria", "files.todos"],
    requiredText: null,
    depth: "all",
    instruction:
      'Link both ways: each todo lists the criteria it builds (criteria: ["c1"]), every criterion has a todo that builds it, every todo serves a criterion, and every file names its todos. The server checks the links exist.',
    rubric:
      "The server already checked the links exist. Pass only if they are real: each todo actually builds the criteria it lists, and each file's change actually belongs to its todos. Fail nominal links.",
    source: "Requirements traceability (bidirectional)",
  },
  {
    id: "humanCheckpoints",
    label: "사람 필요 지점",
    fields: ["humanCheckpoints"],
    requiredText: "humanCheckpoints",
    depth: "all",
    instruction:
      'Where a person must act: sign-in, permissions, tokens, payment, external waits. Or "none" with the reason.',
    rubric:
      "Pass only if humanCheckpoints lists each point where a person must act, or says none with a believable reason given the todos and files.",
    source: "BusyBoy: the user is often away, so plans say up front where they are needed",
  },
  {
    id: "budget",
    label: "예산",
    fields: ["budget"],
    requiredText: "budget",
    depth: "full",
    instruction:
      "Set the time or token appetite, and say which scope is cut if the work runs over.",
    rubric:
      "Pass only if budget sets a concrete appetite (time or tokens) and names the scope that is cut if it runs over.",
    source: "Shape Up, Set Boundaries (https://basecamp.com/shapeup/1.2-chapter-03)",
  },
  {
    id: "risks",
    label: "위험",
    fields: ["risks"],
    requiredText: "risks",
    depth: "full",
    instruction:
      "Pre-mortem: assume it failed and say why. Name the rabbit holes. Map each risk to the todo or non-goal that handles it.",
    rubric:
      "Pass only if risks reads like a pre-mortem (concrete ways this plan fails), names rabbit holes, and maps each risk to a todo or a non-goal in this spec.",
    source:
      "Klein, Performing a Project Premortem, HBR 2007 (https://hbr.org/2007/09/performing-a-project-premortem); Shape Up, Risks and Rabbit Holes (https://basecamp.com/shapeup/1.4-chapter-05)",
  },
  {
    id: "alternatives",
    label: "대안",
    fields: ["alternatives"],
    requiredText: "alternatives",
    depth: "full",
    instruction: "List the options you considered and why each was rejected.",
    rubric:
      "Pass only if alternatives names at least one real option besides the chosen one, with a concrete reason it was rejected.",
    source:
      "Design Docs at Google (https://www.industrialempathy.com/posts/design-docs-at-google/)",
  },
];

/** What a lead does when its plan checker ends without a verdict. */
export const PLAN_CHECKER_ENDED_HINT =
  'If you are told the checker\'s task ended and no verdict message came, call ask_user(kind: "approval") again; that restarts the check on the next model without counting a round.';

/** Most rounds the checker sends a plan back before the card goes up anyway. */
export const MAX_PLAN_CHECK_ROUNDS = 3;

/** Small tasks get the light plan unless the plan itself is large. */
export function planDepth(size: ProjectTaskSize | null, spec: ProjectTaskSpec): PlanDepth {
  return size === "small" && !isFullPlan(spec) ? "light" : "full";
}

export function requiredPlanGates(depth: PlanDepth): ReadonlyArray<PlanGate> {
  return PLAN_GATES.filter((gate) => depth === "full" || gate.depth === "all");
}

/** The empty required gates, and a missing size, as plan readiness gaps. */
export function planGateGaps(spec: ProjectTaskSpec, size: ProjectTaskSize | null): Array<string> {
  const gaps: Array<string> = [];
  if (size === null) {
    gaps.push(
      "size: set the task size with task_update(size) (small, medium or large) before asking; it decides which plan gates are required",
    );
  }
  for (const gate of requiredPlanGates(planDepth(size, spec))) {
    if (gate.requiredText === null) continue;
    if (spec[gate.requiredText].trim().length > 0) continue;
    gaps.push(`gate ${gate.id} "${gate.label}" (${gate.requiredText}): ${gate.instruction}`);
  }
  return gaps;
}

/** The gate procedure in the lead prompt, generated from PLAN_GATES. */
export function planGatesPromptSection(): string {
  const lines = PLAN_GATES.map(
    (gate, index) =>
      `   ${index + 1}. ${gate.id} "${gate.label}" (${gate.fields.join(", ")}${gate.depth === "full" ? "; full plans only" : ""}): ${gate.instruction}`,
  );
  return lines.join("\n");
}

/** The brief a plan checker session starts with. */
export function planCheckerBrief(input: {
  readonly taskId: string;
  /** Such as BB-7. */
  readonly key: string;
  readonly title: string;
  readonly specVersion: number;
  readonly round: number;
  readonly depth: PlanDepth;
}): string {
  const gates = requiredPlanGates(input.depth);
  const rubric = gates
    .map((gate) => `- ${gate.id} "${gate.label}" (${gate.fields.join(", ")}): ${gate.rubric}`)
    .join("\n");
  return `You are the plan checker for task ${input.key} "${input.title}" (task id ${input.taskId}). Check round ${input.round}.

Read the plan with task_spec_read(taskId: "${input.taskId}") and judge the version you read. You were asked for spec version ${input.specVersion}; if the version you read is not v${input.specVersion}, the plan changed, so still record your verdicts with the version you read and the server treats the check as stale.

This is a ${input.depth} plan, so judge these ${gates.length} gates, each against its rubric:
${rubric}

Be strict. Fail a gate whose content is thin, vague or hand-wavy, that only restates the field name, or whose links are nominal rather than real. You may read the code to confirm claims about the current state. Do not edit any file, the spec, or the task.

When done, call task_plan_check_set(taskId: "${input.taskId}", specVersion: <the version you read, normally ${input.specVersion}>, verdicts) with one verdict for every gate above: { gate: "<id>", pass: true|false, reason }. Each reason is one sentence in the user's language: Korean if the spec is written in Korean. Then end your turn.`;
}
