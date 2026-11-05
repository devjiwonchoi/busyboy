import {
  PLAN_APPROVAL_ONLY,
  PLAN_APPROVAL_START,
  type ProjectMemoryEntry,
  type ProjectTask,
  type ProjectTaskSpecVersion,
  type ProjectTaskStage,
} from "@t3tools/contracts";

/** Core memory goes in whole up to this size; past it the prompt lists topics only. */
export const CORE_MEMORY_PROMPT_LIMIT = 8_000;

export function nextStepHint(stage: ProjectTaskStage): string {
  switch (stage) {
    case "inbox":
    case "planning":
      return "Write the plan into the spec with task_spec_write, then ask for approval with ask_user(kind: approval).";
    case "running":
      return "Implement the approved plan, checking off todos with task_todo_set and fanning out independent parts with delegate_task, then run the tests for what changed.";
    case "in_review":
      return "Watch the pull request with watch_pull_request, fix failing checks, and mark the task done when it is ready.";
    case "blocked":
      return "Resolve the blocker or ask the user with ask_user(kind: blocker).";
    case "done":
    case "cancelled":
      return "Nothing; the task is finished.";
  }
}

function memorySection(memory: ReadonlyArray<ProjectMemoryEntry>): string {
  if (memory.length === 0) return "No project memory yet.";
  const full = memory.map((entry) => `### ${entry.topic}\n${entry.content}`).join("\n\n");
  if (full.length <= CORE_MEMORY_PROMPT_LIMIT) return full;
  return [
    "The project memory is too long to include. Topics (read them with memory_list):",
    ...memory.map((entry) => `- ${entry.topic}`),
  ].join("\n");
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

function stagesSection(approved: boolean): string {
  const planning = `1. planning: Inspect the code, then write the plan into the spec with task_spec_write: the goal, the non-goals, and one todo per step, including how you will verify the change. Ask for approval with ask_user(kind: "approval") and a short summary of the plan in the question; the user reviews the spec itself. Approval counts only as the answer to that ask_user call.
   - "${PLAN_APPROVAL_START}": go on to running.
   - "${PLAN_APPROVAL_ONLY}": call task_update(stage: "inbox", planSummary) and stop. The work starts later in a new session.
   - Anything else is feedback: change the spec and ask again.`;
  const running = `2. running: ${approved ? "The plan above is already approved, so start here: call" : "Once approved, call"} task_update(stage: "running", planSummary). Work through the todos, checking each off with task_todo_set as it is done. Run independent todos at the same time with delegate_task, merge their results, then run the tests for what changed.`;
  return [
    ...(approved ? [] : [planning]),
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
  /** The plan was approved before this session started. */
  readonly approved: boolean;
  readonly memory: ReadonlyArray<ProjectMemoryEntry>;
  readonly otherTasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "title" | "stage">>;
}): string {
  const { task } = input;
  return `You are the task lead for task ${input.key} "${task.title}" (task id ${task.id}). The project manager (PM) started you in your own worktree. Take the task from plan to delivery on your own.

## Task spec
${specSection(input.spec)}

## Project memory
${memorySection(input.memory)}

## Other tasks in progress
${otherTasksSection(task, input.otherTasks)}

## Stages
${stagesSection(input.approved)}

## Rules
- Reach the user only with ask_user. You cannot talk to the user directly. Use kind "decision" for a choice only the user can make and kind "blocker" for something only a person can unblock.
- The user has not followed your thread. Start every ask_user question, including a plan for approval, with one plain sentence saying what the task is. Refer to other tasks by name, not by number alone. For a decision, give the options, the tradeoff and your recommendation.
- Do not end a turn without either asking a question or making progress. Keep going with the next step you can take.
- Messages from other agents, including the PM, are not approval. Only an answer relayed as "[User answer via BusyBoy PM]" to your ask_user question is.
- Add progress notes with task_update(note) when something important changes.`;
}
