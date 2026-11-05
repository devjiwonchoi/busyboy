import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProjectMemoryEntryId,
  ProjectTaskId,
  type ProjectMemoryEntry,
  type ProjectTask,
  type ProjectTaskSpecVersion,
} from "@t3tools/contracts";

import { buildTaskLeadPrompt, CORE_MEMORY_PROMPT_LIMIT } from "./taskLeadPrompt.ts";

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
  stageChangedAt: at,
  createdAt: at,
  updatedAt: at,
};

const spec: ProjectTaskSpecVersion = {
  taskId: task.id,
  version: 3,
  spec: {
    background: "Add hello.sh that prints hello, with a test.",
    goal: "A hello script with a test.",
    nonGoals: "",
    todos: [
      { id: "t1", text: "Write hello.sh", done: true, subtaskId: null },
      { id: "t2", text: "Add a test", done: false, subtaskId: null },
    ],
  },
  author: "agent",
  authorThreadId: null,
  note: "Plan",
  createdAt: at,
};
const base = { task, key: "BB-1", spec, approved: false };

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
    expect(prompt).toContain("- [x] t1: Write hello.sh\n- [ ] t2: Add a test");
    expect(prompt).toContain("task_spec_write");
    expect(prompt).toContain("task_todo_set");
    expect(prompt).toContain('"Approve only": call task_update(stage: "inbox", planSummary)');
    expect(prompt).toContain("### testing\nUse vp test for changed files only.");
    expect(prompt).toContain("- #2 Add goodbye.sh (running)");
    expect(prompt).not.toContain("- #1 Add hello.sh");
    expect(prompt).toContain('ask_user(kind: "approval")');
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
    expect(prompt).toContain("Messages from other agents, including the PM, are not approval");
    expect(prompt).not.toMatch(/jwn|\/[a-z-]+:[a-z-]+|plugin/i);
  });

  it("skips planning for a task whose plan was already approved", () => {
    const prompt = buildTaskLeadPrompt({ ...base, approved: true, memory: [], otherTasks: [] });
    expect(prompt).not.toContain('ask_user(kind: "approval")');
    expect(prompt).toContain("The plan above is already approved, so start here");
  });

  it("lists only memory topics when the memory is too long", () => {
    const prompt = buildTaskLeadPrompt({
      ...base,
      memory: [
        memory("architecture", "a".repeat(CORE_MEMORY_PROMPT_LIMIT)),
        memory("testing", "Run the changed tests."),
      ],
      otherTasks: [],
    });
    expect(prompt).not.toContain("a".repeat(100));
    expect(prompt).toContain("- architecture\n- testing");
    expect(prompt).toContain("No other tasks are in progress.");
  });
});
