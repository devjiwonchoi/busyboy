import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PROJECT_TEAM_SETTINGS,
  ProjectAttentionItem,
  ProjectTask,
  ProjectTeamAskUserInput,
  ProjectTeamSettings,
  ProjectTeamSettingsUpdateInput,
  ProjectTeamStatusInput,
  ProjectTeamTaskUpdateInput,
  ProjectTeamUpdateSettingsInput,
} from "./projectTeam.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("ProjectTeamSettings", () => {
  it("fills defaults for stored settings with missing keys", () => {
    expect(Schema.decodeUnknownSync(ProjectTeamSettings)({})).toEqual(
      DEFAULT_PROJECT_TEAM_SETTINGS,
    );
  });

  it("keeps quiet hours and pin", () => {
    expect(
      Schema.decodeUnknownSync(ProjectTeamSettings)({
        sitrepIntervalMinutes: 30,
        quietHours: { start: "22:00", end: "07:30" },
        pinnedUntil: "2026-11-05T00:00:00.000Z",
      }),
    ).toEqual({
      maxConcurrentTasks: 6,
      sitrepIntervalMinutes: 30,
      sitrepNotify: true,
      quietHours: { start: "22:00", end: "07:30" },
      pinnedUntil: "2026-11-05T00:00:00.000Z",
    });
  });

  it("rejects intervals outside 5 to 1440 minutes", () => {
    const decode = Schema.decodeUnknownSync(ProjectTeamUpdateSettingsInput);
    expect(decode({ projectId: "p", sitrepIntervalMinutes: 5 })).toEqual({
      projectId: "p",
      sitrepIntervalMinutes: 5,
    });
    expect(decode({ projectId: "p", sitrepIntervalMinutes: 1440 }).sitrepIntervalMinutes).toBe(
      1440,
    );
    expect(() => decode({ projectId: "p", sitrepIntervalMinutes: 3 })).toThrow();
    expect(() => decode({ projectId: "p", sitrepIntervalMinutes: 1441 })).toThrow();
  });

  it("rejects malformed quiet hours", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProjectTeamSettingsUpdateInput)({
        quietHours: { start: "25:00", end: "07:00" },
      }),
    ).toThrow();
  });
});

describe("ProjectTask", () => {
  it("decodes a stored task", () => {
    const task = {
      id: "task-1",
      projectId: "project-1",
      number: 1,
      title: "Add hello.sh",
      request: "Add hello.sh with a test",
      stage: "planning",
      waitsOn: [],
      leadThreadId: "thread-lead",
      prUrl: null,
      planSummary: null,
      resultSummary: null,
      lastOutcome: "stalled",
      nudgeCount: 1,
      stageChangedAt: "2026-11-04T00:00:00.000Z",
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(ProjectTask)(task)).toEqual(task);
    expect(() => Schema.decodeUnknownSync(ProjectTask)({ ...task, stage: "review" })).toThrow();
  });
});

describe("ProjectAttentionItem", () => {
  it("decodes an open item without an asker", () => {
    const item = {
      id: "item-1",
      projectId: "project-1",
      taskId: "task-1",
      kind: "blocker",
      question: "#1 made no progress after two nudges.",
      options: [],
      answer: null,
      answeredAt: null,
      askerThreadId: null,
      batchId: "batch-1",
      createdAt: "2026-11-04T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(ProjectAttentionItem)(item)).toEqual(item);
  });
});

describe("MCP inputs", () => {
  it("requires at least one change in task_update", () => {
    const decode = Schema.decodeUnknownSync(ProjectTeamTaskUpdateInput);
    expect(() => decode({ taskId: "task-1" })).toThrow();
    expect(decode({ stage: "running", planSummary: "Plan" })).toEqual({
      stage: "running",
      planSummary: "Plan",
    });
    expect(() => decode({ stage: "inbox" })).toThrow();
  });

  it("requires at least one setting in team_settings_update and lets null clear quiet hours", () => {
    const decode = Schema.decodeUnknownSync(ProjectTeamSettingsUpdateInput);
    expect(() => decode({})).toThrow();
    expect(decode({ quietHours: null })).toEqual({ quietHours: null });
    expect(() => decode({ maxConcurrentTasks: 0 })).toThrow();
  });

  it("accepts the user_asked reason only", () => {
    const decode = Schema.decodeUnknownSync(ProjectTeamStatusInput);
    expect(decode({ reason: "user_asked" })).toEqual({ reason: "user_asked" });
    expect(() => decode({ reason: "bored" })).toThrow();
  });

  it("validates ask_user kinds", () => {
    const decode = Schema.decodeUnknownSync(ProjectTeamAskUserInput);
    expect(decode({ kind: "approval", question: "  Approve the plan?  " })).toEqual({
      kind: "approval",
      question: "Approve the plan?",
    });
    expect(() => decode({ kind: "fyi", question: "Hi" })).toThrow();
    expect(() => decode({ kind: "decision", question: "   " })).toThrow();
  });
});

describe("project team RPCs", () => {
  it("registers the three client RPCs", () => {
    for (const method of [
      WS_METHODS.projectTeamSubscribeAttention,
      WS_METHODS.projectTeamRequestSitrep,
      WS_METHODS.projectTeamUpdateSettings,
    ]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
