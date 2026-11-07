/** Intake and breakdown rules that need no storage: duplicate titles and what can start. */

import type { ProjectTask, ProjectTaskStage } from "@t3tools/contracts";

const FINISHED: ReadonlySet<ProjectTaskStage> = new Set(["done", "cancelled"]);

/** Stages before a task's plan is approved; a parent here has not approved its breakdown. */
export const PRE_APPROVAL_STAGES: ReadonlySet<ProjectTaskStage> = new Set([
  "inbox",
  "planning",
  "awaiting_approval",
]);

/**
 * A title reduced to its words, so "BU-12: Fix the login redirect." and
 * "fix login redirect" match. Drops a leading task key, articles and punctuation.
 */
export function normalizeTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*[a-z][a-z0-9]*-\d+\s*[:\-–—]?\s*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 0 && word !== "the" && word !== "a" && word !== "an")
    .join(" ");
}

/** An open task with the same normalized title, if any. */
export function findOpenDuplicate<T extends Pick<ProjectTask, "title" | "stage">>(
  tasks: ReadonlyArray<T>,
  title: string,
): T | undefined {
  const wanted = normalizeTaskTitle(title);
  if (wanted.length === 0) return undefined;
  return tasks.find(
    (task) => !FINISHED.has(task.stage) && normalizeTaskTitle(task.title) === wanted,
  );
}

/** All children finished and at least one done: the parent's work is complete. */
export function allSubtasksDone(children: ReadonlyArray<Pick<ProjectTask, "stage">>): boolean {
  return (
    children.length > 0 &&
    children.every((child) => FINISHED.has(child.stage)) &&
    children.some((child) => child.stage === "done")
  );
}

/** Inbox subtasks split into those whose waitsOn are all in review or done, and the rest. */
export function splitReadySubtasks<T extends Pick<ProjectTask, "stage" | "waitsOn">>(
  subtasks: ReadonlyArray<T>,
  stageOf: (taskId: string) => ProjectTaskStage | undefined,
): { readonly ready: ReadonlyArray<T>; readonly waiting: ReadonlyArray<T> } {
  const inbox = subtasks.filter((task) => task.stage === "inbox");
  const isReady = (task: T) =>
    task.waitsOn.every((id) => {
      const stage = stageOf(id);
      return stage === "in_review" || stage === "done";
    });
  return { ready: inbox.filter(isReady), waiting: inbox.filter((task) => !isReady(task)) };
}
