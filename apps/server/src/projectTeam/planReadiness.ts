/**
 * Definition of Ready for a task's plan, and the evidence check before In Review.
 * The server only checks that each part exists and that the links hold, not what it says.
 */
import type { ProjectTaskSize, ProjectTaskSpec } from "@t3tools/contracts";

import { isFullPlan, planGateGaps } from "./planGates.ts";

export { isFullPlan };

const isBlank = (text: string) => text.trim().length === 0;
const list = (ids: ReadonlyArray<string>) => ids.join(", ");

/** Web UI files: a plan that touches them shows a prototype of the end state. */
export function isUiFile(path: string): boolean {
  return path.startsWith("apps/web/") || /\.(tsx|css)$/.test(path);
}

/** Links that point at ids the spec does not have. Agents' writes are refused on these. */
export function specLinkProblems(spec: ProjectTaskSpec): Array<string> {
  const todoIds = new Set(spec.todos.map((todo) => todo.id));
  const criterionIds = new Set(spec.criteria.map((criterion) => criterion.id));
  const problems: Array<string> = [];
  for (const todo of spec.todos) {
    const unknownCriteria = todo.criteria.filter((id) => !criterionIds.has(id));
    if (unknownCriteria.length > 0) {
      problems.push(`todo ${todo.id} lists unknown criteria: ${list(unknownCriteria)}`);
    }
    const unknownTodos = todo.dependsOn.filter((id) => !todoIds.has(id) || id === todo.id);
    if (unknownTodos.length > 0) {
      problems.push(`todo ${todo.id} depends on unknown todos: ${list(unknownTodos)}`);
    }
  }
  for (const file of spec.files) {
    const unknownTodos = file.todos.filter((id) => !todoIds.has(id));
    if (unknownTodos.length > 0) {
      problems.push(`file ${file.path} lists unknown todos: ${list(unknownTodos)}`);
    }
  }
  return problems;
}

/**
 * What the plan still needs before the user can review it; empty when it is ready.
 * `size` is the task's size: it picks the plan gates, and a missing size is a gap.
 */
export function planReadinessGaps(
  spec: ProjectTaskSpec,
  size: ProjectTaskSize | null,
): Array<string> {
  const gaps: Array<string> = [];
  if (isBlank(spec.summary)) {
    gaps.push(
      "summary: 2-4 sentences in your own words: what is wrong today and what the user sees when it is done",
    );
  }
  if (isBlank(spec.goal)) gaps.push("goal: describe the end state the user will see");
  if (spec.criteria.length === 0) {
    gaps.push("criteria: add at least one success criterion");
  }
  const unproven = spec.criteria.filter((criterion) => isBlank(criterion.provenBy));
  if (unproven.length > 0) {
    gaps.push(
      `criteria ${list(unproven.map((criterion) => criterion.id))}: say how each is proven (provenBy)`,
    );
  }
  const built = new Set(spec.todos.flatMap((todo) => todo.criteria));
  const unbuilt = spec.criteria.filter((criterion) => !built.has(criterion.id));
  if (unbuilt.length > 0) {
    gaps.push(
      `criteria ${list(unbuilt.map((criterion) => criterion.id))}: no todo builds them (list them in a todo's criteria)`,
    );
  }
  const aimless = spec.todos.filter((todo) => todo.criteria.length === 0);
  if (aimless.length > 0) {
    gaps.push(
      `todos ${list(aimless.map((todo) => todo.id))}: serve no criterion (link them, or drop them if they are delivery steps the stages already cover)`,
    );
  }
  const unchecked = spec.todos.filter((todo) => isBlank(todo.doneWhen));
  if (unchecked.length > 0) {
    gaps.push(
      `todos ${list(unchecked.map((todo) => todo.id))}: say how the user can tell each is done (doneWhen)`,
    );
  }
  if (spec.todos.length === 0) gaps.push("todos: add the steps that build the criteria");
  if (spec.files.length === 0) {
    gaps.push("files: list every file the plan adds, changes or deletes, and why");
  }
  if (isFullPlan(spec) && isBlank(spec.flow)) {
    gaps.push(
      "flow: this plan is large (4+ todos, 6+ files, or ordered todos), so add a Mermaid diagram of the behavior",
    );
  }
  if (
    spec.files.some((file) => isUiFile(file.path)) &&
    isBlank(spec.prototype) &&
    isBlank(spec.prototypeWaiver)
  ) {
    gaps.push(
      "prototype: the plan changes UI, so add an HTML mockup of the end state, or say why not in prototypeWaiver",
    );
  }
  return [...specLinkProblems(spec), ...gaps, ...planGateGaps(spec, size)];
}

/** Criteria still without evidence; In Review waits until there are none. */
export function unprovenCriteria(spec: ProjectTaskSpec): Array<string> {
  return spec.criteria
    .filter((criterion) => criterion.evidence === null || isBlank(criterion.evidence))
    .map((criterion) => criterion.id);
}
