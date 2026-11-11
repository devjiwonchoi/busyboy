/**
 * Rules for avoidable stalls: time a task could have moved but the system or the
 * process stopped it. A wait on the user (an open card) and a hold with a resume
 * condition are not stalls, and memory stalls stay with the memory governor.
 *
 * Each stall gets one wake (the lead, or the PM for a task nobody started) after
 * STALL_WAKE_AFTER_MS and one message to the user after STALL_NOTIFY_AFTER_MS.
 */
import {
  PROJECT_TASK_STALL_CAUSE_LABELS,
  type ProjectAttentionContext,
  type ProjectAttentionDetail,
  type ProjectTask,
  type ProjectTaskResumeWhen,
  type ProjectTaskStallCause,
  type ProjectTaskStage,
} from "@t3tools/contracts";

import { MINUTE_MS } from "./common.ts";

export const STALL_WAKE_AFTER_MS = 10 * MINUTE_MS;
export const STALL_NOTIFY_AFTER_MS = 20 * MINUTE_MS;
/** A lead that has not started a turn this long after an answer did not get it. */
export const ANSWER_REDELIVER_AFTER_MS = 2 * MINUTE_MS;

export const STALL_CAUSE_LABELS = PROJECT_TASK_STALL_CAUSE_LABELS;

/** What the hold waits for, in plain words. */
export function resumeWhenText(
  resumeWhen: ProjectTaskResumeWhen,
  titleOf: (taskId: string) => string | undefined,
): string {
  switch (resumeWhen.type) {
    case "task":
      return `${titleOf(resumeWhen.taskId) ?? "다른 태스크"} 작업이 끝나면`;
    case "time":
      return `${resumeWhen.at} 이후`;
    case "user":
      return `사용자가 정하면 (${resumeWhen.note})`;
  }
}

/**
 * Whether a hold's condition holds now. A user condition never holds by itself:
 * the PM starts the task on the user's word.
 */
export function holdConditionMet(
  resumeWhen: ProjectTaskResumeWhen,
  nowMs: number,
  stageOf: (taskId: string) => ProjectTaskStage | undefined,
): boolean {
  switch (resumeWhen.type) {
    case "task": {
      const stage = stageOf(resumeWhen.taskId);
      // A task that no longer exists cannot hold this one back.
      return stage === undefined || stage === "done" || stage === "cancelled";
    }
    case "time":
      return nowMs >= Date.parse(resumeWhen.at);
    case "user":
      return false;
  }
}

/** Live stages whose lead should be moving; in review waits on checks and the PM. */
export const WATCHED_LIVE_STAGES: ReadonlySet<ProjectTaskStage> = new Set(["planning", "running"]);

/**
 * Why a live task sits still, or null when it is not stalled: its lead is at work,
 * it waits on the user, it is held, or memory holds it (the governor's).
 */
export function liveStallCause(input: {
  readonly task: Pick<ProjectTask, "stage" | "hold" | "memoryHold" | "leadThreadId">;
  readonly leadBusy: boolean;
  readonly openCards: number;
  /** When the lead last started or finished a turn, or the stage last changed. */
  readonly progressAtMs: number;
  /** When the user last answered one of the task's cards, if ever. */
  readonly answeredAtMs: number | null;
}): { readonly cause: ProjectTaskStallCause; readonly sinceMs: number } | null {
  const { task } = input;
  if (!WATCHED_LIVE_STAGES.has(task.stage) || task.leadThreadId === null) return null;
  if (task.hold != null || task.memoryHold != null) return null;
  if (input.leadBusy || input.openCards > 0) return null;
  if (input.answeredAtMs !== null && input.answeredAtMs >= input.progressAtMs) {
    return { cause: "answered_idle", sinceMs: input.answeredAtMs };
  }
  return { cause: "no_progress", sinceMs: input.progressAtMs };
}

/** How long a stall has run, in whole minutes, for messages. */
export const stallMinutes = (sinceMs: number, nowMs: number) =>
  Math.max(1, Math.round((nowMs - sinceMs) / MINUTE_MS));

/** A title short enough for a message's first line. */
function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > 28 ? `${flat.slice(0, 27).trimEnd()}…` : flat;
}

export interface StallCard {
  readonly question: string;
  readonly details: ReadonlyArray<ProjectAttentionDetail>;
  readonly context: ProjectAttentionContext;
}

/** What 다시 시작 does, for the card's folded context. */
export function restartContext(by: "lead" | "pm"): ProjectAttentionContext {
  return {
    action:
      by === "lead"
        ? "멈춘 작업을 리드가 멈춘 곳부터 이어서 하도록 다시 시작해요."
        : "PM이 이 작업을 바로 시작해요.",
    reason: "진행할 수 있었는데 시스템이나 절차 때문에 멈춰 있어요.",
    impacts: [],
    cost: null,
    reversibility: "reversible",
    recommendation: "다시 시작을 추천해요. 일부러 멈춘 거라면 다시 시작할 조건을 남겨 주세요.",
  };
}

/** The one message the user gets for a stall the server could not clear itself. */
export function stallCard(input: {
  readonly cause: Exclude<ProjectTaskStallCause, "start_failed">;
  readonly title: string;
  readonly minutes: number;
  readonly lastActivity?: string | null;
  readonly holdText?: string | null;
}): StallCard {
  const title = shortTitle(input.title);
  const restartLead = "다시 시작하면 리드가 멈춘 곳부터 이어서 해요. 되돌릴 수 있어요.";
  const restartPm =
    "다시 시작하면 PM이 바로 시작해요. 일부러 멈춘 거라면 PM에게 다시 시작할 조건을 남기라고 해 주세요.";
  const [headline, why, next] = (() => {
    switch (input.cause) {
      case "no_progress":
        return [
          `${title} 작업이 ${input.minutes}분째 멈춰 있어요. 다시 시작할까요?`,
          "리드가 끝내지도 묻지도 않고 멈춰서 10분 전에 한 번 깨웠는데 그대로예요.",
          restartLead,
        ];
      case "answered_idle":
        return [
          `${title} 작업이 답을 받고도 ${input.minutes}분째 멈춰 있어요. 다시 시작할까요?`,
          "답을 리드에게 전한 뒤 진행이 없어서 10분 전에 한 번 깨웠는데 그대로예요.",
          restartLead,
        ];
      case "not_started":
        return [
          `${title} 작업을 시작할 수 있는데 ${input.minutes}분째 시작되지 않았어요. 시작할까요?`,
          "기다리는 다른 일이 없고 자리도 있어요. 10분 전에 PM에게 시작하라고 알렸는데 그대로예요.",
          restartPm,
        ];
      case "hold_not_resumed":
        return [
          `${title} 작업의 다시 시작 조건이 풀렸는데 ${input.minutes}분째 그대로예요. 시작할까요?`,
          "조건이 풀려서 PM에게 시작하라고 알렸는데 아직 시작하지 않았어요.",
          restartPm,
        ];
    }
  })();
  const details: Array<ProjectAttentionDetail> = [
    { label: "원인", text: STALL_CAUSE_LABELS[input.cause] },
    { label: "멈춘 시간", text: `${input.minutes}분` },
  ];
  if (input.holdText) details.push({ label: "다시 시작 조건", text: input.holdText });
  if (input.lastActivity) details.push({ label: "마지막 활동", text: input.lastActivity });
  const byLead = input.cause === "no_progress" || input.cause === "answered_idle";
  return {
    question: [headline, why, next].join("\n\n"),
    details,
    context: restartContext(byLead ? "lead" : "pm"),
  };
}

/** The line that wakes a lead whose task made no progress. */
export function leadWakeText(cause: "no_progress" | "answered_idle"): string {
  return cause === "answered_idle"
    ? '[자동 재개] 사용자의 답을 받은 뒤 10분 넘게 진행이 없어요. 답을 반영해서 멈춘 곳부터 이어서 하세요. 막혔으면 ask_user로 알려요. 일부러 멈출 거면 task_update(stage: "inbox", hold)로 다시 시작 조건을 남겨요.'
    : '[자동 재개] 10분 넘게 진행이 없어요. 멈춘 곳부터 이어서 하세요. 막혔으면 ask_user로 알려요. 일부러 멈출 거면 task_update(stage: "inbox", hold)로 다시 시작 조건을 남겨요.';
}
