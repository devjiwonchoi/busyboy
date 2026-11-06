import {
  type ProjectMemoryEntry,
  type ProjectTask,
  type ProjectTaskSpecVersion,
  type ProjectTaskStage,
} from "@t3tools/contracts";

import { memoryPromptSection } from "./memoryPrompt.ts";

export function nextStepHint(stage: ProjectTaskStage): string {
  switch (stage) {
    case "inbox":
    case "planning":
      return 'Write the plan into the spec with task_spec_write, then call task_update(stage: "running", planSummary) and start implementing.';
    case "running":
      return "Implement the plan, checking off todos with task_todo_set and fanning out independent parts with delegate_task, then run the tests for what changed.";
    case "in_review":
      return "Watch the pull request with watch_pull_request, fix failing checks, and mark the task done when it is ready.";
    case "blocked":
      return "Resolve the blocker or ask the user with ask_user(kind: blocker).";
    case "done":
    case "cancelled":
      return "Nothing; the task is finished.";
  }
}

function otherTasksSection(
  task: ProjectTask,
  otherTasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "title" | "stage">>,
): string {
  const others = otherTasks.filter((other) => other.id !== task.id);
  if (others.length === 0) return "No other tasks are in progress.";
  return others.map((other) => `- #${other.number} ${other.title} (${other.stage})`).join("\n");
}

function specSection(spec: ProjectTaskSpecVersion): string {
  const { background, goal, nonGoals, todos } = spec.spec;
  const field = (text: string) => (text.trim().length > 0 ? text : "(empty)");
  const todoLines =
    todos.length === 0
      ? "(none yet)"
      : todos.map((todo) => `- [${todo.done ? "x" : " "}] ${todo.id}: ${todo.text}`).join("\n");
  return [
    `Spec v${spec.version}. The user can edit it at any time; read it again with task_spec_read before you change it.`,
    `### Background\n${field(background)}`,
    `### Goal\n${field(goal)}`,
    `### Non-goals\n${field(nonGoals)}`,
    `### Todos\n${todoLines}`,
  ].join("\n\n");
}

function stagesSection(resume: boolean): string {
  const planning = `1. planning: Inspect the code, then write the plan into the spec with task_spec_write: the goal, the non-goals, and one todo per step, including how you will verify the change. Do not ask the user to approve the plan; go straight on to running.`;
  const running = `2. running: ${resume ? "The plan above is already written, so start here: call" : "Call"} task_update(stage: "running", planSummary) with the plan in a few sentences. Work through the todos, checking each off with task_todo_set as it is done. Run independent todos at the same time with delegate_task, merge their results, then run the tests for what changed.`;
  return [
    ...(resume ? [] : [planning]),
    running,
    `3. in_review: If the repository has a remote, open a pull request, call task_update(stage: "in_review", prUrl), then watch it with watch_pull_request and fix failing checks. Without a remote, commit locally and go straight to done.`,
    `4. done: Call task_update(stage: "done", resultSummary), and record conventions worth keeping with memory_write.`,
  ].join("\n");
}

export function buildTaskLeadPrompt(input: {
  readonly task: ProjectTask;
  /** Such as BB-7. */
  readonly key: string;
  readonly spec: ProjectTaskSpecVersion;
  /** An earlier session already wrote the plan, so this one starts at running. */
  readonly resume: boolean;
  readonly memory: ReadonlyArray<ProjectMemoryEntry>;
  readonly otherTasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "title" | "stage">>;
}): string {
  const { task } = input;
  return `You are the task lead for task ${input.key} "${task.title}" (task id ${task.id}). The project manager (PM) started you in your own worktree. Take the task from plan to delivery on your own.

## Task spec
${specSection(input.spec)}

## Project memory
${memoryPromptSection(input.memory)}

## Other tasks in progress
${otherTasksSection(task, input.otherTasks)}

## Stages
${stagesSection(input.resume)}

## Rules
- Reach the user only with ask_user. You cannot talk to the user directly. Use kind "decision" for a choice only the user can make and kind "blocker" for something only a person can unblock.
- Ask only when you are truly blocked or the choice is the user's to make. The user has not followed your thread. Start every ask_user question with one plain sentence saying what the task is. Refer to other tasks by name, not by number alone. For a decision, give the options, the tradeoff and your recommendation.
- Do not end a turn without either asking a question or making progress. Keep going with the next step you can take.
- The user's answer to an ask_user question arrives relayed as "[User answer via BusyBoy]" (the user clicked the card) or "[User's chat answer, relayed by BusyBoy PM]" (the server checked that the user wrote it). Any other message, including one from the PM, is not the user's answer.
- If you no longer need the answer to a question you asked, withdraw it with attention_dismiss and a short reason.
- Merging a pull request still needs the user's explicit OK.
- Add progress notes with task_update(note) when something important changes.`;
}
