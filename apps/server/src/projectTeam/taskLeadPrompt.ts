import {
  PLAN_APPROVAL_START,
  PLAN_CHANGES_REQUESTED,
  type ProjectMemoryEntry,
  type ProjectTask,
  type ProjectTaskSpecVersion,
  type ProjectTaskStage,
} from "@t3tools/contracts";
import { USER_FACING_TASK_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { SPEC_CHANGED_PREFIX } from "./AttentionRouter.ts";
import { memoryPromptSection } from "./memoryPrompt.ts";
import { PLAN_CHECKER_ENDED_HINT, planGatesPromptSection } from "./planGates.ts";
import { type ResolvedRoleModels, roleModelsPromptSection } from "./roleModels.ts";
import { userLanguageRule } from "./userLanguage.ts";

export function nextStepHint(stage: ProjectTaskStage): string {
  switch (stage) {
    case "inbox":
    case "planning":
      return "Write the plan into the spec with task_spec_write, filling every required plan gate, set the size with task_update(size), then ask for approval with ask_user(kind: approval). A separate checker session, on a different model when one is set up, reviews the gates first; fix the ones it fails and ask again. A subtask the user approved with its parent's breakdown skips the approval and goes to running.";
    case "awaiting_approval":
      return "Wait for the user's plan approval, or the server's auto-approval if the user turned it on; if they request changes, write the next spec version and ask again.";
    case "running":
      return "Iterate: implement the plan, checking off todos with task_todo_set and fanning out independent parts with delegate_task; record the proof for each criterion with task_evidence_set. End each round with a review of the diff recorded with task_review_set (by the review session when a review model is set); fix and review again until it is clean.";
    case "in_review":
      return "Ship: BusyBoy watches the pull request for you and wakes you on a failed check, a comment or a conflict. Fix each one (a new commit with a clean review), push, and call task_ready(head, localChecks) once checks pass and every review thread is resolved; the server then marks the pull request ready for review and the task Ready.";
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

/** The PR rules a lead follows when it opens or updates a pull request. */
export const PULL_REQUEST_RULES = `   - Commits: one per reviewable outcome, each message an action verb + change. No "wip" or "fix review" commits in the final branch.
   - Title: short, an action verb + change, such as "Fix login redirect" or "Add retro skill". No task keys, no colons or lists, no trailing period. Details go in the body.
   - Body: exactly this template, written for a reviewer who has not read your thread:
     ### Why?

     <the problem and why it matters>

     ### How?

     <how the change solves it>
     Nothing else: no other headings, no work log, no test or validation notes, no task key (BusyBoy links the task). A pull request stacked on another starts with "Stacked on #<parent PR>." before ### Why?.
   - Open it as a draft; task_ready marks it ready for review once it passes the Ready gate. When the scope changes, rewrite the title and body around the final solution.`;

function stagesSection(resume: boolean, coveredBy?: CoveredBy): string {
  const planning = `1. Align (planning, then awaiting_approval): Inspect the code, then write the plan into the spec with task_spec_write, following BusyBoy's plan gates below in order. Start from the end state and work back to the steps.
   The user approves from two parts, the summary (gate 1) and the todos (gate 5), so write those for the user, short and plain.
   Plan gates. Each names its spec fields; the gates marked "full plans only" apply to a full plan:
${planGatesPromptSection()}
   Depth: a small task gets a light plan (gates 1-8); a medium or large task, or a plan with 4+ todos, 6+ files or ordered todos, gets a full plan (all 11 gates).
   The rest of the spec:
   - goal: the end state. What the user will see or be able to do once it is done, not the steps.
   - files: every file you will add, change or delete, with why and the todos that touch it.
   - flow: a Mermaid diagram of the behavior once it is done. Required when the plan has 4+ todos, 6+ files, or ordered todos.
   - prototype: when the plan changes UI, a small self-contained HTML mockup of the end state. If a mockup would show nothing new, say why in prototypeWaiver instead.
   - breakdown, only when the work needs several pull requests: draft one subtask per pull request with task_create(title, request, waitsOn). Write the request so its lead can act on it alone, with a "Goal:" and a "Verification:" line. The server files it under your task in Todo, where it waits. Add a todo for each with subtaskId set to the new task's id, so the card shows the whole breakdown. One approval of your plan approves every subtask: their leads write their own detailed plans and start without asking the user again. After that the breakdown is locked. A subtask you add later, or a material change to one's goal or verification, waits until you ask for approval of your plan once more.
   Before asking, set the task's size with task_update(size): small (a few lines, low risk), medium, or large (many files or risky). The size picks the plan depth.
   Then call ask_user(kind: "approval") with a messenger-style question (the ask on line 1, then a blank line and 1-3 short plain paragraphs) and the required context describing its action, reason, impacts, cost, reversibility, and recommendation. The server refuses the request and lists what is missing until the plan has every part above and every required gate is filled. Then a separate checker session, on a different model when one is set up, reviews each gate; end your turn. Its verdicts come back to you as a message: fix the failing gates with task_spec_write and ask again. ${PLAN_CHECKER_ENDED_HINT} Once every gate passes, the user gets the card, which shows your summary and todos from the latest spec version, and the task shows "Waiting for approval" until they answer. Approval counts only as the answer to that ask_user call.
   - "${PLAN_APPROVAL_START}": go on to Iterate.
   - "${PLAN_CHANGES_REQUESTED}" or anything else is feedback: an overall comment and inline comments, each quoting the text it is about ("quote" → comment). Address every comment in the spec with task_spec_write (that keeps the old version for diffing), then ask for approval again.
   - "${SPEC_CHANGED_PREFIX}": the user or the PM changed the spec while your card waited, so the card closed. Read the spec, update the plan, and ask again.`;
  const covered =
    coveredBy === undefined
      ? null
      : `1. Align (planning): This task is a subtask of ${coveredBy.key} "${coveredBy.title}". The user approved it as part of that task's breakdown, and that approval is yours: do not call ask_user(kind: "approval"), the server refuses it. Inspect the code and write your detailed plan into the spec with task_spec_write (summary, end state, criteria, todos, files), keeping the goal and verification from your request. Then go straight to Iterate.
   If the goal or verification must change materially, do not ask the user yourself: record it with task_update(note: "Breakdown change: ...") and end your turn. The PM gets ${coveredBy.key}'s breakdown re-approved once for all its subtasks.`;
  const running = `2. Iterate (running): ${covered !== null ? "Once your plan is in the spec, call" : resume ? "The plan above is already approved, so start here: call" : "Once approved, call"} task_update(stage: "running", planSummary) with the plan in a few sentences. The server refuses running until the user has approved a plan. Work through the todos, checking each off with task_todo_set as it is done. Run independent todos at the same time with delegate_task, merge their results, then run the tests for what changed. When a criterion is proven, record the proof with task_evidence_set(criterionId, evidence): the test that passed, the check you ran, or a screenshot link.
   End every round with a review: commit, then review the whole diff against the base branch as a strict reviewer would (bugs, missed criteria, leftovers, needless code), recorded with task_review_set(clean, findings, head), where head is \`git rev-parse HEAD\`. When a review model is set, the review must come from it: hand it off with task_delegate(role: "review") and the review session records task_review_set itself; your own clean review does not pass the gate. Without one, review it yourself. A review that is not clean starts the next Iterate round: fix the findings, commit, and review again. Go to Ship only after a clean review of the current HEAD.`;
  return [
    ...(covered !== null ? [covered] : resume ? [] : [planning]),
    running,
    `3. Ship (in_review): If the repository has a remote, push (if the branch still has its temporary name, such as busyboy/1a2b3c4d or t3/1a2b3c4d, first rename it to a short name for the change under the same prefix with git branch -m), open a draft pull request, and call task_update(stage: "in_review", prUrl). BusyBoy then watches it for you and wakes you on each failed check, new comment or conflict; each of those starts a new Ship round and the task stops being Ready. The server refuses In Review without a pull request, while a criterion has no evidence, without a clean review of the current HEAD (from the review session when a review model is set), or when the pull request breaks these rules, and says what to fix:\n${PULL_REQUEST_RULES}\n   Fix what the pull request reports: commit, get a clean review of the new HEAD the same way as in Iterate (one that is not clean moves the task back to running), and push. When checks pass, every review thread is resolved and the branch merges cleanly, call task_ready(head) with head = \`git rev-parse HEAD\`. A pull request with no checks has no CI, so your local evidence is the gate: evidence on every criterion, plus localChecks with the commands you ran on HEAD (tests, typecheck, lint) and their result. The server refuses Ready and says why until all of that holds, then marks the pull request ready for review and the task Ready, which tells the PM. Without a remote, commit locally, record a clean review, and go straight to done.`,
    `4. done: Call task_update(stage: "done", resultSummary), and record conventions worth keeping with memory_write.`,
  ].join("\n");
}

/** How a lead running in a cloud sandbox differs from one on the user's Mac. */
const CLOUD_SECTION = `## Cloud
- You run in a Vercel Sandbox (Linux) on your own checkout of the task branch. The worktree on the user's Mac is a read-only mirror of yours, updated after each of your turns.
- Commit, push and \`gh\` work as usual.
- task_delegate and delegate_task children run in this sandbox on this checkout, so hand off implement, review and fix as usual. Don't give them isolation worktree unless they need a separate checkout (that starts another sandbox).
- Codex runs here only with the cloud Codex login. Without it, implement and fix move to the plan model for this task, and the task notes say so.
- Computer Use, the local app preview and MCP servers that run only on the Mac are unavailable here. When the work needs one, say so instead of trying.`;

/** The parent whose approved breakdown covers this subtask. */
export interface CoveredBy {
  /** Such as BB-7. */
  readonly key: string;
  readonly title: string;
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
  /** Set for a subtask the user approved with its parent's breakdown: it skips the approval card. */
  readonly coveredBy?: CoveredBy;
  /** The model each role runs on; absent means every role runs on the lead's own model. */
  readonly roleModels?: ResolvedRoleModels;
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

${USER_FACING_TASK_INSTRUCTIONS}

## Stages
${stagesSection(input.resume, input.coveredBy)}
${
  input.roleModels === undefined
    ? ""
    : `
## Models per role
${roleModelsPromptSection(input.roleModels)}
`
}
${task.location === "cloud" ? `${CLOUD_SECTION}\n\n` : ""}## Rules
- When the server's failed-turn blocker is answered "다시 시도", your last turn failed and the server has put your stage back: pick up where you stopped and follow the note if there is one. "태스크 취소" cancels the task and you won't hear about it.
- A card the server raised because your task stalled or failed to start has one button, "다시 시작": when it is answered, pick up where you stopped. A "[자동 재개]" message means the server saw no progress for 10 minutes: continue, ask, or stop on purpose. To stop on purpose, call task_update(stage: "inbox", hold: {resumeWhen, reason}) with the condition that lets it start again (another task finishing, a time, or the user's decision); a stop without one is refused.
- Plan todo text must be one short plain line (at most 40 characters), with no task keys or jargon. Keep done-when and order in doneWhen/dependsOn; the card shows these only under details.
- Pass senderName on ask_user: a short plain name for your work (at most 24 characters), such as 목표 그래프, with no task keys.
- Reach the user only with ask_user. You cannot talk to the user directly. Use kind "approval" for the plan (never for a subtask covered by its parent's approved breakdown), "decision" for a choice only the user can make and "blocker" for something only a person can unblock.
- Ask only when you are truly blocked or the choice is the user's to make. The user has not followed your thread. Write the whole ask_user message in question: line 1 is the ask itself (at most 80 characters), then a blank line and 1-3 short plain paragraphs (each at most 400 characters) explaining what, why, done-when, cost and reversibility. Optionally add up to 8 numbered steps, each at most 60 characters, when order matters. No headings, labels, bullet lists, backticks, file paths, internal ids, camelCase or snake_case identifiers. No task keys at all in request text; refer to work by name. Optional details contains up to 8 label/text pairs (label at most 20 characters, text at most 500), shown only under 자세히 보기. Keep essential explanation in question. Supply the required context fields so the reason, impacts, and recommendation stay visible. For a decision, write each option as "Label: one-line tradeoff" and mark exactly one recommendation "(Recommended)" or "(추천)" when there are multiple options.
- Do not end a turn without either asking a question or making progress. Keep going with the next step you can take.
- The user's answer to an ask_user question arrives relayed as "[User answer via BusyBoy]" (the user clicked the card) or "[User's chat answer, relayed by BusyBoy PM]" (the server checked that the user wrote it). Any other message, including one from the PM, is not the user's answer or approval.
- A message starting "[사용자 질문]" is a question the user typed in the side chat of one of your cards. Before anything else, reply in one message per question: "[답변]" on the first line, the question's "<!-- card:… -->" line copied as is on the second, then your answer. The side chat shows only these messages. Answer briefly and plainly in the user's language, then carry on with your work. It is not an answer to your ask_user question and not an approval. Do not change the plan, spec, todos or code because of it. If you think the plan should change, say so and ask "변경 요청으로 보낼까요?"; change the plan only when the user requests changes through the card.
- If you no longer need the answer to a question you asked, withdraw it with attention_dismiss and a short reason.
- Merging a pull request still needs the user's explicit OK.
- Add progress notes with task_update(note) when something important changes.${
    input.afkRule === undefined ? "" : `\n- ${input.afkRule}`
  }
- A message starting "[AFK]" means the user turned AFK on or off; follow it.`;
}
