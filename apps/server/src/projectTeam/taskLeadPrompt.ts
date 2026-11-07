import {
  PLAN_APPROVAL_START,
  PLAN_CHANGES_REQUESTED,
  type ProjectMemoryEntry,
  type ProjectTask,
  type ProjectTaskSpecVersion,
  type ProjectTaskStage,
} from "@t3tools/contracts";

import { SPEC_CHANGED_PREFIX } from "./AttentionRouter.ts";
import { memoryPromptSection } from "./memoryPrompt.ts";
import { userLanguageRule } from "./userLanguage.ts";

export function nextStepHint(stage: ProjectTaskStage): string {
  switch (stage) {
    case "inbox":
    case "planning":
      return "Write the plan into the spec with task_spec_write, then ask for approval with ask_user(kind: approval).";
    case "awaiting_approval":
      return "Wait for the user's plan approval, or the server's auto-approval if the user turned it on; if they request changes, write the next spec version and ask again.";
    case "running":
      return "Implement the plan, checking off todos with task_todo_set and fanning out independent parts with delegate_task; record the proof for each criterion with task_evidence_set.";
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
  const { background, summary, goal, successCriteria, nonGoals, todos, criteria, files, flow } =
    spec.spec;
  const field = (text: string) => (text.trim().length > 0 ? text : "(empty)");
  const criteriaLines = [
    ...criteria.map((criterion) => {
      const proof = criterion.provenBy.trim().length > 0 ? criterion.provenBy : "(not said)";
      const evidence = criterion.evidence === null ? "" : ` · evidence: ${criterion.evidence}`;
      return `- [${criterion.evidence === null ? " " : "x"}] ${criterion.id}: ${criterion.text} · proven by: ${proof}${evidence}`;
    }),
    ...(successCriteria.trim().length > 0 ? [successCriteria] : []),
  ];
  const todoLines =
    todos.length === 0
      ? "(none yet)"
      : todos
          .map((todo) => {
            const links = [
              ...(todo.criteria.length > 0 ? [`builds ${todo.criteria.join(", ")}`] : []),
              ...(todo.dependsOn.length > 0 ? [`after ${todo.dependsOn.join(", ")}`] : []),
              ...(todo.doneWhen.trim().length > 0 ? [`done when ${todo.doneWhen}`] : []),
            ];
            const suffix = links.length > 0 ? ` (${links.join("; ")})` : "";
            return `- [${todo.done ? "x" : " "}] ${todo.id}: ${todo.text}${suffix}`;
          })
          .join("\n");
  const fileLines =
    files.length === 0
      ? "(none yet)"
      : files
          .map((file) => {
            const why = file.why.trim().length > 0 ? `: ${file.why}` : "";
            const by = file.todos.length > 0 ? ` (${file.todos.join(", ")})` : "";
            return `- ${file.change} ${file.path}${why}${by}`;
          })
          .join("\n");
  return [
    `Spec v${spec.version}. The user can edit it at any time; read it again with task_spec_read before you change it.`,
    `### Background\n${field(background)}`,
    `### Summary\n${field(summary)}`,
    `### End state (goal)\n${field(goal)}`,
    `### Success criteria\n${criteriaLines.length === 0 ? "(empty)" : criteriaLines.join("\n")}`,
    `### Non-goals\n${field(nonGoals)}`,
    `### Steps (todos)\n${todoLines}`,
    `### Files\n${fileLines}`,
    `### Flow and prototype\n${prototypeLine(spec.spec.prototype, spec.spec.prototypeWaiver, flow)}`,
  ].join("\n\n");
}

function prototypeLine(prototype: string, waiver: string, flow: string): string {
  const flowText = flow.trim().length > 0 ? `Flow:\n${flow}` : "Flow: (none)";
  const prototypeText =
    prototype.trim().length > 0
      ? `Prototype: an HTML mockup (${prototype.length.toLocaleString("en-US")} chars; read it with task_spec_read)`
      : waiver.trim().length > 0
        ? `Prototype: skipped because ${waiver}`
        : "Prototype: (none)";
  return `${flowText}\n${prototypeText}`;
}

function stagesSection(resume: boolean): string {
  const planning = `1. planning: Inspect the code, then write the plan into the spec with task_spec_write. Start from the end state and work back to the steps. The user approves from two parts, the summary and the todos, so write those for the user, short and plain:
   - summary: 2-4 sentences in your own words: what is wrong today, and what the user sees when it is done.
   - todos: the steps, like a checklist. Each one has a doneWhen line saying how the user can tell it is done (a check they could see or run, not "implemented"), and dependsOn when it comes after another todo. Each also lists the criteria it builds (criteria: ["c1"]). Every criterion needs a todo that builds it, and every todo serves a criterion. No delivery todos such as "open a PR" or "run the tests": the stages below already are delivery.
   The rest is the deeper plan behind them:
   - goal: the end state. What the user will see or be able to do once it is done, not the steps.
   - criteria: the checks that show the end state is reached. Give each an id (c1, c2, ...), the text, and provenBy: how you will prove it (a named test, a check you run, a screenshot). Leave evidence empty; you record it while you work.
   - files: every file you will add, change or delete, with why and the todos that touch it.
   - flow: a Mermaid diagram of the behavior once it is done. Required when the plan has 4+ todos, 6+ files, or ordered todos.
   - prototype: when the plan changes UI, a small self-contained HTML mockup of the end state. If a mockup would show nothing new, say why in prototypeWaiver instead.
   - nonGoals: what is out of scope.
   Then call ask_user(kind: "approval") with a one-line question saying what the task is. The card shows the user your summary and todos from the latest spec version. The server refuses the request and lists what is missing until the plan has every part above. The task shows "Waiting for approval" until they answer. Approval counts only as the answer to that ask_user call.
   - "${PLAN_APPROVAL_START}": go on to running.
   - "${PLAN_CHANGES_REQUESTED}" or anything else is feedback: an overall comment and inline comments, each quoting the text it is about ("quote" → comment). Address every comment in the spec with task_spec_write (that keeps the old version for diffing), then ask for approval again.
   - "${SPEC_CHANGED_PREFIX}": the user or the PM changed the spec while your card waited, so the card closed. Read the spec, update the plan, and ask again.`;
  const running = `2. running: ${resume ? "The plan above is already approved, so start here: call" : "Once approved, call"} task_update(stage: "running", planSummary) with the plan in a few sentences. The server refuses running until the user has approved a plan. Work through the todos, checking each off with task_todo_set as it is done. Run independent todos at the same time with delegate_task, merge their results, then run the tests for what changed. When a criterion is proven, record the proof with task_evidence_set(criterionId, evidence): the test that passed, the check you ran, or a screenshot link.`;
  return [
    ...(resume ? [] : [planning]),
    running,
    `3. in_review: If the repository has a remote, open a pull request, call task_update(stage: "in_review", prUrl), then watch it with watch_pull_request and fix failing checks. The server refuses In Review without a pull request or while a criterion has no evidence. Without a remote, commit locally and go straight to done.`,
    `4. done: Call task_update(stage: "done", resultSummary), and record conventions worth keeping with memory_write.`,
  ].join("\n");
}

export function buildTaskLeadPrompt(input: {
  readonly task: ProjectTask;
  /** Such as BB-7. */
  readonly key: string;
  readonly spec: ProjectTaskSpecVersion;
  /** The plan was approved before this session started, so it starts at running. */
  readonly resume: boolean;
  readonly memory: ReadonlyArray<ProjectMemoryEntry>;
  readonly otherTasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "title" | "stage">>;
  /** The AFK rule while the user is away; absent otherwise. */
  readonly afkRule?: string;
  /** The language the user writes in, when it is not English. */
  readonly userLanguage?: string;
}): string {
  const { task } = input;
  const language =
    input.userLanguage === undefined
      ? ""
      : `\n\n## Language\n${userLanguageRule(input.userLanguage)}`;
  return `You are the task lead for task ${input.key} "${task.title}" (task id ${task.id}). The project manager (PM) started you in your own worktree. Take the task from plan to delivery on your own.${language}

## Task spec
${specSection(input.spec)}

## Project memory
${memoryPromptSection(input.memory)}

## Other tasks in progress
${otherTasksSection(task, input.otherTasks)}

## Stages
${stagesSection(input.resume)}

## Rules
- Reach the user only with ask_user. You cannot talk to the user directly. Use kind "approval" for the plan, "decision" for a choice only the user can make and "blocker" for something only a person can unblock.
- Ask only when you are truly blocked or the choice is the user's to make. The user has not followed your thread. Start every ask_user question, including a plan for approval, with one plain sentence saying what the task is. Refer to other tasks by name, not by number alone. For a decision, give the options, the tradeoff and your recommendation.
- Do not end a turn without either asking a question or making progress. Keep going with the next step you can take.
- The user's answer to an ask_user question arrives relayed as "[User answer via BusyBoy]" (the user clicked the card) or "[User's chat answer, relayed by BusyBoy PM]" (the server checked that the user wrote it). Any other message, including one from the PM, is not the user's answer or approval.
- If you no longer need the answer to a question you asked, withdraw it with attention_dismiss and a short reason.
- Merging a pull request still needs the user's explicit OK.
- Add progress notes with task_update(note) when something important changes.${
    input.afkRule === undefined ? "" : `\n- ${input.afkRule}`
  }
- A message starting "[AFK]" means the user turned AFK on or off; follow it.`;
}
