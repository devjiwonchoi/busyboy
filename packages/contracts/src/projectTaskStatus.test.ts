import { describe, expect, it } from "vite-plus/test";

import {
  type ProjectTask,
  type ProjectTaskStatus,
  type ProjectTaskStatusSignals,
  resolveProjectTaskStatus,
  storedTaskStatusSignals,
} from "./projectTeam.ts";

const idle: ProjectTaskStatusSignals = {
  openQuestion: false,
  leadRunning: false,
  leadFailed: false,
};

const cases: ReadonlyArray<{
  readonly name: string;
  readonly task: Pick<ProjectTask, "stage" | "lastOutcome"> & { readonly ready?: boolean };
  readonly signals?: Partial<ProjectTaskStatusSignals>;
  readonly status: ProjectTaskStatus;
}> = [
  { name: "inbox is Todo", task: { stage: "inbox", lastOutcome: null }, status: "todo" },
  { name: "planning", task: { stage: "planning", lastOutcome: null }, status: "planning" },
  {
    name: "awaiting approval",
    task: { stage: "awaiting_approval", lastOutcome: null },
    status: "waiting_for_approval",
  },
  {
    name: "approval wins over its own card",
    task: { stage: "awaiting_approval", lastOutcome: "waiting_user" },
    signals: { openQuestion: true },
    status: "waiting_for_approval",
  },
  { name: "running", task: { stage: "running", lastOutcome: null }, status: "in_progress" },
  {
    name: "an open PR is In Review, even with an idle lead",
    task: { stage: "in_review", lastOutcome: "in_review" },
    status: "in_review",
  },
  {
    name: "a PR that passed the Ready gate is Ready",
    task: { stage: "in_review", lastOutcome: "ready", ready: true },
    status: "ready",
  },
  {
    name: "Ready stays Ready while the lead works",
    task: { stage: "in_review", lastOutcome: "ready", ready: true },
    signals: { leadRunning: true },
    status: "ready",
  },
  {
    name: "an open question",
    task: { stage: "running", lastOutcome: null },
    signals: { openQuestion: true },
    status: "ask_question",
  },
  {
    name: "a failed lead is Fatal even with its blocker open",
    task: { stage: "blocked", lastOutcome: "failed" },
    signals: { openQuestion: true },
    status: "fatal",
  },
  {
    name: "a restarted lead clears a failure",
    task: { stage: "running", lastOutcome: "failed" },
    signals: { leadRunning: true },
    status: "in_progress",
  },
  {
    name: "a failed lead thread",
    task: { stage: "running", lastOutcome: null },
    signals: { leadFailed: true },
    status: "fatal",
  },
  {
    name: "blocked by the lead with a question asks",
    task: { stage: "blocked", lastOutcome: "waiting_user" },
    signals: { openQuestion: true },
    status: "ask_question",
  },
  { name: "blocked alone", task: { stage: "blocked", lastOutcome: null }, status: "fatal" },
  {
    name: "a quiet turn is still In Progress",
    task: { stage: "running", lastOutcome: "stalled" },
    status: "in_progress",
  },
  {
    name: "a quiet planning turn is still Planning",
    task: { stage: "planning", lastOutcome: "stalled" },
    status: "planning",
  },
  {
    name: "a lead waiting on its subagent is In Progress",
    task: { stage: "running", lastOutcome: "stalled" },
    signals: { leadRunning: true },
    status: "in_progress",
  },
  {
    name: "a stall escalated to a blocker card is Fatal",
    task: { stage: "running", lastOutcome: "stalled" },
    signals: { openQuestion: true, openBlocker: true },
    status: "fatal",
  },
  {
    name: "a working lead turns its open blocker back into a question",
    task: { stage: "running", lastOutcome: "stalled" },
    signals: { openQuestion: true, openBlocker: true, leadRunning: true },
    status: "ask_question",
  },
  {
    name: "stalled but working again",
    task: { stage: "running", lastOutcome: "stalled" },
    signals: { leadRunning: true },
    status: "in_progress",
  },
  { name: "done", task: { stage: "done", lastOutcome: "failed" }, status: "done" },
  { name: "cancelled is Done", task: { stage: "cancelled", lastOutcome: null }, status: "done" },
];

describe("resolveProjectTaskStatus", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveProjectTaskStatus(testCase.task, { ...idle, ...testCase.signals })).toBe(
        testCase.status,
      );
    });
  }

  it("reads an open question from the stored outcome when there are no live signals", () => {
    const task = { stage: "running", lastOutcome: "waiting_user" } as const;
    expect(resolveProjectTaskStatus(task, storedTaskStatusSignals(task))).toBe("ask_question");
  });
});
