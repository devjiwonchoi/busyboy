import { describe, expect, it } from "@effect/vitest";
import {
  emptyProjectTaskSpec,
  newProjectTaskTodo,
  ProjectId,
  ProjectMemoryEntryId,
  ProjectTaskId,
  type ProjectMemoryEntry,
  type ProjectTask,
  type ProjectTaskSpecVersion,
} from "@t3tools/contracts";

import { MEMORY_PROMPT_BUDGET } from "./memoryPrompt.ts";
import { buildTaskLeadPrompt } from "./taskLeadPrompt.ts";

const projectId = ProjectId.make("project-1");
const at = "2026-11-04T00:00:00.000Z";

const task: ProjectTask = {
  id: ProjectTaskId.make("task-1"),
  projectId,
  number: 1,
  title: "Add hello.sh",
  request: "Add hello.sh that prints hello, with a test.",
  stage: "planning",
  waitsOn: [],
  parentTaskId: null,
  leadThreadId: null,
  prUrl: null,
  planSummary: null,
  resultSummary: null,
  lastOutcome: null,
  nudgeCount: 0,
  iterateRound: 0,
  shipRound: 0,
  review: null,
  stageChangedAt: at,
  createdAt: at,
  updatedAt: at,
};

const spec: ProjectTaskSpecVersion = {
  taskId: task.id,
  version: 3,
  spec: {
    ...emptyProjectTaskSpec("Add hello.sh that prints hello, with a test."),
    summary: "There is no hello script. Running hello.sh prints hello.",
    goal: "A hello script with a test.",
    criteria: [
      { id: "c1", text: "hello.sh prints hello", provenBy: "hello.test.sh", evidence: "passed" },
      { id: "c2", text: "It exits 0", provenBy: "hello.test.sh", evidence: null },
    ],
    todos: [
      {
        ...newProjectTaskTodo("t1", "Write hello.sh"),
        done: true,
        criteria: ["c1", "c2"],
        doneWhen: "it prints hello",
      },
      { ...newProjectTaskTodo("t2", "Add a test"), criteria: ["c1"], dependsOn: ["t1"] },
    ],
    files: [
      { path: "hello.sh", change: "new", why: "The script", todos: ["t1"] },
      { path: "hello.test.sh", change: "new", why: "", todos: ["t2"] },
    ],
    flow: "flowchart LR\n  run --> hello",
    prototypeWaiver: "No UI.",
  },
  author: "agent",
  authorThreadId: null,
  note: "Plan",
  createdAt: at,
};
const base = { task, key: "BB-1", spec, resume: false };

const memory = (topic: string, content: string): ProjectMemoryEntry => ({
  id: ProjectMemoryEntryId.make(`memory-${topic}`),
  projectId,
  topic,
  content,
  updatedAt: at,
});

describe("buildTaskLeadPrompt", () => {
  it("carries the request, memory, other tasks and the built-in stage rules", () => {
    const prompt = buildTaskLeadPrompt({
      ...base,
      memory: [memory("testing", "Use vp test for changed files only.")],
      otherTasks: [
        task,
        { id: ProjectTaskId.make("task-2"), number: 2, title: "Add goodbye.sh", stage: "running" },
      ],
    });
    expect(prompt).toContain('task BB-1 "Add hello.sh"');
    expect(prompt).toContain("Spec v3.");
    expect(prompt).toContain("### Background\nAdd hello.sh that prints hello, with a test.");
    expect(prompt).toContain("### Non-goals\n(empty)");
    expect(prompt).toContain(
      "- [x] t1: Write hello.sh (builds c1, c2; done when it prints hello)\n- [ ] t2: Add a test (builds c1; after t1)",
    );
    expect(prompt).toContain("task_spec_write");
    expect(prompt).toContain("task_todo_set");
    expect(prompt).toContain("### End state (goal)\nA hello script with a test.");
    expect(prompt).toContain(
      "### Success criteria\n- [x] c1: hello.sh prints hello · proven by: hello.test.sh · evidence: passed\n- [ ] c2: It exits 0 · proven by: hello.test.sh",
    );
    expect(prompt).toContain(
      "### Files\n- new hello.sh: The script (t1)\n- new hello.test.sh (t2)",
    );
    expect(prompt).toContain(
      "Flow:\nflowchart LR\n  run --> hello\nPrototype: skipped because No UI.",
    );
    // The structured plan and its gates.
    expect(prompt).toContain("goal: the end state.");
    // The card no longer takes goal and verification bullets.
    expect(prompt).not.toContain("goal and verification");
    expect(prompt).toContain("provenBy: how you will prove it");
    expect(prompt).toContain(
      "Every criterion needs a todo that builds it, and every todo serves a criterion.",
    );
    expect(prompt).toContain('No delivery todos such as "open a PR" or "run the tests"');
    expect(prompt).toContain("The server refuses the request and lists what is missing");
    expect(prompt).toContain("The server refuses running until the user has approved a plan.");
    expect(prompt).toContain("task_evidence_set(criterionId, evidence)");
    expect(prompt).toContain("The server refuses In Review without a pull request");
    // Align → Iterate → Ship, with a self-review closing every Iterate round.
    expect(prompt).toContain("1. Align (planning, then awaiting_approval):");
    expect(prompt).toContain("2. Iterate (running):");
    expect(prompt).toContain("3. Ship (in_review):");
    expect(prompt).toContain("task_review_set(clean, findings, head)");
    expect(prompt).toContain("without a clean self-review of the current HEAD");
    expect(prompt).toContain('"[Spec changed]": the user or the PM changed the spec');
    expect(prompt).not.toContain("## Language");
    // Leads ask the user to approve the plan and read inline review comments.
    expect(prompt).toContain('ask_user(kind: "approval")');
    expect(prompt).toContain("The card shows the user your summary and todos");
    expect(prompt).toContain(
      "summary: 2-4 sentences in your own words: what is wrong today, and what the user sees when it is done.",
    );
    expect(prompt).toContain(
      "Each one has a doneWhen line saying how the user can tell it is done",
    );
    expect(prompt).toContain(
      "### Summary\nThere is no hello script. Running hello.sh prints hello.",
    );
    expect(prompt).toContain('"Approve and start": go on to Iterate.');
    expect(prompt).not.toContain("Approve only");
    expect(prompt).toContain('"Request changes" or anything else is feedback');
    expect(prompt).toContain("### testing\nUse vp test for changed files only.");
    expect(prompt).toContain("- #2 Add goodbye.sh (running)");
    expect(prompt).not.toContain("- #1 Add hello.sh");
    expect(prompt).toContain('task_update(stage: "running", planSummary)');
    expect(prompt).toContain("delegate_task");
    expect(prompt).toContain('task_update(stage: "in_review", prUrl)');
    expect(prompt).toContain("watch_pull_request");
    expect(prompt).toContain("Without a remote, commit locally");
    expect(prompt).toContain('task_update(stage: "done", resultSummary)');
    expect(prompt).toContain("memory_write");
    expect(prompt).toContain("Reach the user only with ask_user");
    expect(prompt).toContain(
      "Do not end a turn without either asking a question or making progress",
    );
    expect(prompt).toContain('relayed as "[User answer via BusyBoy]" (the user clicked the card)');
    expect(prompt).toContain(
      `"[User's chat answer, relayed by BusyBoy PM]" (the server checked that the user wrote it)`,
    );
    expect(prompt).toContain(
      "Any other message, including one from the PM, is not the user's answer or approval.",
    );
    expect(prompt).toContain("withdraw it with attention_dismiss");
    expect(prompt).toContain("Merging a pull request still needs the user's explicit OK.");
    expect(prompt).not.toMatch(/jwn|\/[a-z-]+:[a-z-]+|plugin/i);
  });

  it("keeps the whole prompt stable", () => {
    expect(buildTaskLeadPrompt({ ...base, memory: [], otherTasks: [] })).toMatchSnapshot();
  });

  it("tells the lead to write what the user reads in the user's language", () => {
    const prompt = buildTaskLeadPrompt({
      ...base,
      memory: [],
      otherTasks: [],
      userLanguage: "Korean",
    });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain(
      "## Language\nThe user writes in Korean. Write everything the user reads in Korean:",
    );
    expect(prompt).toContain("todos and their doneWhen lines");
  });

  it("skips planning for a task whose plan was already approved", () => {
    const prompt = buildTaskLeadPrompt({ ...base, resume: true, memory: [], otherTasks: [] });
    expect(prompt).not.toContain("1. Align (planning, then awaiting_approval):");
    expect(prompt).toContain("The plan above is already approved, so start here");
  });

  it("lets a subtask covered by its parent's approved breakdown skip the approval card", () => {
    const prompt = buildTaskLeadPrompt({
      ...base,
      memory: [],
      otherTasks: [],
      coveredBy: { key: "BB-9", title: "Workflow system" },
    });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('This task is a subtask of BB-9 "Workflow system".');
    expect(prompt).toContain('do not call ask_user(kind: "approval"), the server refuses it');
    expect(prompt).toContain('task_update(note: "Breakdown change: ...")');
    expect(prompt).toContain("Once your plan is in the spec, call task_update");
    expect(prompt).not.toContain('Then call ask_user(kind: "approval")');
  });

  it("teaches the breakdown and the PR rules", () => {
    const prompt = buildTaskLeadPrompt({ ...base, memory: [], otherTasks: [] });
    expect(prompt).toContain("draft one subtask per pull request with task_create");
    expect(prompt).toContain("One approval of your plan approves every subtask");
    expect(prompt).toContain('Title: short, an action verb + change, such as "Fix login redirect"');
    expect(prompt).toContain("### Why?\n\n     <the problem and why it matters>");
    expect(prompt).toContain("no test or validation notes, no task key");
    expect(prompt).toContain('"Stacked on #<parent PR>." before ### Why?');
    expect(prompt).toContain("Open it ready for review, not as a draft.");
  });

  it("keeps decisions whole and indexes other topics when the memory is too long", () => {
    const prompt = buildTaskLeadPrompt({
      ...base,
      memory: [
        memory("architecture", `Layered services.\n${"a".repeat(MEMORY_PROMPT_BUDGET)}`),
        memory("decisions", "Squash-merge only."),
      ],
      otherTasks: [],
    });
    expect(prompt).not.toContain("a".repeat(100));
    expect(prompt).toContain("### decisions\nSquash-merge only.");
    expect(prompt).toContain("- architecture (2026-11-04): Layered services.");
    expect(prompt).toContain("No other tasks are in progress.");
  });
});
