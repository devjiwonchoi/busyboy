import {
  isSandboxRotationDecision,
  SANDBOX_ROTATION_MOVE_LOCAL,
  SANDBOX_ROTATION_OPTIONS,
  isTurnFailedBlocker,
  TURN_FAILED_CANCEL,
  TURN_FAILED_OPTIONS,
  TURN_FAILED_RETRY,
  turnFailedReason,
  approvalPlanOf,
  emptyProjectTaskSpec,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROJECT_TEAM_SETTINGS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  resolveTaskExecutionSettings,
  type ExecutionLocation,
  type IsoDateTime,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type ModelSelection,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpFailure,
  type ProjectAttentionItem,
  PLAN_APPROVAL_START,
  planApprovalOutcome,
  type ProjectDecisionCard,
  type ProjectSitrep,
  type ProjectId,
  type ProjectManagerAvatar,
  type ProjectManagerKind,
  PROJECT_SUMMARY_MAX_LINES,
  PROJECT_SUMMARY_TOPIC,
  DIRECTOR_BRIEFING_TOPIC,
  type ProjectManagerLastAction,
  type ProjectManagerPersona,
  type ProjectManagerPresence,
  type ProjectManagerVoice,
  ProjectMemoryEntryId,
  type ProjectTask,
  type ProjectTaskMemoryHold,
  type ProjectTaskBrief,
  ProjectTaskStatus,
  type ProjectTaskStatusSignals,
  resolveProjectTaskStatus,
  projectTaskPhase,
  storedTaskStatusSignals,
  type ProjectTaskCheck,
  type ProjectTaskEvent,
  ProjectTaskEventId,
  type ProjectTaskEventKind,
  ProjectTaskId,
  type ProjectTaskOutcome,
  type ServerProvider,
  isProviderAvailable,
  ProjectTaskStage,
  type ProjectTeamAskUserInput,
  type ProjectTeamAttentionAnswerInput,
  type ProjectTeamAttentionDismissInput,
  type ProjectTeamAttentionItemResult,
  type ProjectTeamAttentionSnapshot,
  type ProjectTeamAttentionSummary,
  type ProjectTeamError,
  type ProjectTeamJournalEntry,
  type ProjectTeamMemoryDeleteInput,
  type ProjectTeamMemoryDeleteResult,
  type ProjectTeamMemoryListResult,
  type ProjectTeamMemoryWriteInput,
  type ProjectTeamMemoryWriteResult,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAskLeadInput,
  type ProjectTeamAskLeadResult,
  type ProjectTeamRequestSitrepInput,
  type ProjectTeamRequestSitrepResult,
  type ProjectTeamSettings,
  type ProjectTeamSettingsResult,
  type ProjectTeamSettingsUpdateInput,
  type ProjectTeamStatus,
  type ProjectTeamStatusInput,
  type ProjectTeamEpic,
  type ProjectTeamWorkspace,
  type ProjectTeamWorkspaceProject,
  type ProjectTeamTaskCreateInput,
  type ProjectTeamTaskListInput,
  type ProjectTeamTaskListResult,
  type ProjectTeamTaskNudgeInput,
  type ProjectTeamTaskNudgeResult,
  type ProjectTeamTaskReadInput,
  type ProjectTeamTaskReadResult,
  type ProjectTeamTaskResult,
  type ProjectTeamTaskSearchInput,
  type ProjectTeamTaskSearchResult,
  type ProjectTeamTaskStartInput,
  type ProjectTeamTaskStartResult,
  type ProjectTeamTaskUpdateInput,
  type ProjectTeamUpdateSettingsInput,
  type ProjectTeamRestoreTaskSpecInput,
  type ProjectTeamSplitTaskTodoInput,
  type ProjectTeamSplitTaskTodoResult,
  type ProjectTeamSetTaskRoleModelsInput,
  type ProjectTeamMoveTaskInput,
  type ProjectTeamTaskDelegateInput,
  type ProjectTaskDelegatedRole,
  type ProjectTaskModelRole,
  type ProjectTaskModelTarget,
  type ProjectMergeOwner,
  mergeOwnerOf,
  type ProjectTaskRoleModelsPatch,
  applyRoleModelsPatch,
  type ProjectTeamTaskDetail,
  type ProjectTeamTaskRefInput,
  type ProjectTeamUpdateTaskSpecInput,
  type ProjectTaskSpec,
  type ProjectTeamTaskSpecReadInput,
  type ProjectTeamTaskSpecResult,
  type ProjectTeamTaskSpecWriteInput,
  type ProjectTeamTaskTodoSetInput,
  type ProjectTeamTaskEvidenceSetInput,
  type ProjectTeamTaskReviewSetInput,
  type ProjectTeamTaskReadyInput,
  type ProjectTaskSpecVersion,
  defaultTaskKeyPrefix,
  formatLeadQuestion,
  formatTaskKey,
  ProviderInstanceId,
  ThreadId,
  AFK_FREE_FORM_ANSWER,
  AFK_GRACE_MS,
  MAX_AFK_ANSWERS_IN_SUMMARY,
  afkActive,
  afkAnswerEventBody,
  afkPickOption,
  afkSetting,
  type ProjectTeamGoalLinkInput,
  type ProjectTeamGoalResult,
  type ProjectTeamGoalWriteInput,
  type ProjectTeamPmNudgeInput,
  type ProjectTeamPmNudgeResult,
  type WorkspaceGoal,
  type WorkspaceGoalAlignment,
  type WorkspaceGoalLink,
  WorkspaceGoalId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import { type AlignableTask, alignWorkspaceGoals } from "@t3tools/shared/workspaceGoals";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isFailedCheck } from "../orchestration-v2/pullRequestWatch.ts";
import type { ProjectTeamRepositoryError } from "../persistence/Errors.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import {
  allSubtasksDone,
  findOpenDuplicate,
  PRE_APPROVAL_STAGES,
  splitReadySubtasks,
} from "./breakdown.ts";
import { directorWorkspaceRoot, epicStage } from "./director.ts";
import { planReadinessGaps, specLinkProblems, unprovenCriteria } from "./planReadiness.ts";
import { isWaitingOnUser, readOtherThreads } from "./otherThreads.ts";
import {
  MINUTE_MS,
  isLeadBusy,
  isoFromMillis,
  isoMillis,
  makeIdGenerator,
  makePeriodicGate,
  nowIso,
  orTeamError,
  teamError,
} from "./common.ts";
import {
  AFK_AGENT_RULE,
  DIRECTOR_PERSONA,
  isUserWordsVoice,
  mergeOwnerChangeText,
  resolvePersona,
  voiceText,
} from "./persona.ts";
import * as FinishedTaskCleanup from "./FinishedTaskCleanup.ts";
import { pullRequestFormatProblems } from "./pullRequestFormat.ts";
import * as PullRequestTextReader from "./PullRequestTextReader.ts";
import * as PullRequestShipGate from "./PullRequestShipGate.ts";
import * as WorktreeHeadReader from "./WorktreeHeadReader.ts";
import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import * as LeadMoveGate from "../cloudLead/LeadMoveGate.ts";
import * as MemoryHeadroom from "../resourceTelemetry/MemoryHeadroom.ts";
import {
  activeLocalLeads,
  admitTaskLead,
  CLOUD_FALLBACK_NOTE,
  MEMORY_WAIT_REASON,
} from "./memoryPolicy.ts";
import { leadControl, moveTaskLead } from "../cloudLead/TaskMover.ts";
import { managerLastMessage } from "./managerLastMessage.ts";
import { type PermissionDenial, permissionBlockerCard } from "./permissionBlocker.ts";
import { PROJECT_DIRECTION_TOPIC, projectDirectionLine } from "./projectDirection.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import {
  DELEGATE_ROLE,
  modelStepEventBody,
  resolveRoleModels,
  type ResolvedRoleModels,
  toDelegateTarget,
} from "./roleModels.ts";
import { buildTaskLeadPrompt, nextStepHint } from "./taskLeadPrompt.ts";
import { liveTaskChildren, taskChildren } from "./taskChildren.ts";
import { allocateTaskKeyPrefixes } from "./taskKeyPrefixes.ts";
import { resolveUserLanguage } from "./userLanguage.ts";

export const MAX_TASK_NUDGES = 2;
const STEP_LABEL: Record<ProjectTaskDelegatedRole, string> = {
  implement: "구현",
  review: "리뷰",
  fix: "수정",
};
const DEFAULT_TASK_EVENT_LIMIT = 20;
/** Stages the PM presence counts; done and cancelled tasks never show. */
/** A task waiting on another may start once that one is in review or done. */
/** How many of the user's latest PM chat messages decide their language. */
const USER_LANGUAGE_SAMPLE = 10;

/** Stages before the work starts; leaving them for running needs an approved plan. */
const PRE_WORK_STAGES: ReadonlySet<ProjectTaskStage> = new Set([
  "inbox",
  "planning",
  "awaiting_approval",
]);
const isDependencyCleared = (stage: ProjectTaskStage) => stage === "in_review" || stage === "done";

const PRESENCE_TASK_STAGES: ReadonlyArray<ProjectTaskStage> = [
  "inbox",
  "planning",
  "awaiting_approval",
  "running",
  "in_review",
];
const DEFAULT_TASK_SEARCH_LIMIT = 20;
const LEAD_MESSAGE_SUMMARY_MAX_CHARS = 300;
export const PM_RELAY_NOT_USER_WORDS =
  "Decision cards need the user's own words. Quote exactly what the user wrote in this chat after the card appeared, or let them click the card.";
/** How a side chat question names the card it was asked from. */
const LEAD_QUESTION_CARD_LABEL = {
  approval: "플랜 승인",
  decision: "결정",
  blocker: "블로커",
} as const;

/** Where a person types: messages the user wrote in the app, not ones an agent or the server sent. */
const USER_TYPED_SOURCES: ReadonlySet<OrchestrationV2ConversationMessage["creationSource"]> =
  new Set(["web", "mobile"]);

const normalizeWords = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** `part` appears in `whole` with no letter or digit right before or after it. */
const containsWords = (whole: string, part: string) => {
  const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
  for (let at = whole.indexOf(part); at !== -1; at = whole.indexOf(part, at + 1)) {
    if (!isWordChar(whole[at - 1]) && !isWordChar(whole[at + part.length])) return true;
  }
  return false;
};

/**
 * True when `answer` is the user's own words: it equals, or after normalizing whitespace and
 * case appears as whole words in, a message the user typed at or after `sinceMs`. Whole words
 * keep a one-letter answer like "B" from matching any message that contains a "b".
 */
export function isUserChatAnswer(
  answer: string,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  sinceMs: number,
): boolean {
  const trimmed = answer.trim();
  const normalized = normalizeWords(answer);
  if (normalized.length === 0) return false;
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.createdBy === "user" &&
      USER_TYPED_SOURCES.has(message.creationSource) &&
      DateTime.toEpochMillis(message.createdAt) >= sinceMs &&
      (message.text.trim() === trimmed || containsWords(normalizeWords(message.text), normalized)),
  );
}

/** Stages whose task lead has work to show; stalled tasks come from these. */
const LIVE_TASK_STAGES: ReadonlySet<ProjectTaskStage> = new Set([
  "planning",
  "running",
  "in_review",
]);

export const JOURNAL_LIMIT = 20;
const JOURNAL_TEXT_MAX_CHARS = 200;
/** Answered or replaced cards kept in the PM chat after they close. */
const CLOSED_DECISION_CARD_LIMIT = 30;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Wakes a project's PM when the Director routes a task to it. */
export function directorAddedTaskWakeText(
  key: string,
  task: Pick<ProjectTask, "id" | "title">,
): string {
  return [
    `[Director added task] ${key} ${task.title}`,
    `The Director put it in your Todo on the user's behalf. Treat it as the user's request and start it now with task_start (taskId: ${task.id}). If every slot is busy or a waitsOn task is unfinished, it waits in Todo until you can start it; tell the user in one line.`,
  ].join("\n");
}

const trimJournalText = (text: string): string =>
  text.length <= JOURNAL_TEXT_MAX_CHARS ? text : `${text.slice(0, JOURNAL_TEXT_MAX_CHARS - 1)}…`;

/**
 * The team's recent history for team_status, newest first: tasks that finished or
 * failed, leads' plans, the user's answered questions, and posted sitreps.
 */
export function buildJournal(input: {
  readonly tasks: ReadonlyArray<Pick<ProjectTask, "id" | "number" | "title">>;
  readonly endings: ReadonlyArray<Pick<ProjectTaskEvent, "taskId" | "kind" | "body" | "createdAt">>;
  readonly answered: ReadonlyArray<
    Pick<ProjectAttentionItem, "taskId" | "question" | "answer" | "answeredAt">
  >;
  readonly sitreps: ReadonlyArray<Pick<ProjectSitrep, "body" | "createdAt">>;
  readonly limit?: number;
}): Array<ProjectTeamJournalEntry> {
  const taskById = new Map(input.tasks.map((task) => [task.id as string, task]));
  const label = (taskId: string | null) => {
    if (taskId === null) return "a PM question";
    const task = taskById.get(taskId);
    return task === undefined ? "a task" : `#${task.number}`;
  };
  const entries: Array<ProjectTeamJournalEntry> = [];
  for (const event of input.endings) {
    const task = event.taskId === null ? undefined : taskById.get(event.taskId);
    if (event.kind === "summary") {
      // A lead's plan: it starts without approval, so the journal is where the PM sees it.
      entries.push({
        at: event.createdAt,
        kind: "decision",
        text: trimJournalText(
          `${task === undefined ? "Plan" : `Plan for #${task.number} ${task.title}`}: ${event.body.replace(/^Plan: /, "")}`,
        ),
      });
    } else if (event.kind === "outcome") {
      entries.push({
        at: event.createdAt,
        kind: "failed",
        text: trimJournalText(
          task === undefined
            ? `A task failed: ${event.body}`
            : `#${task.number} failed: ${task.title}`,
        ),
      });
    } else {
      entries.push({
        at: event.createdAt,
        kind: "done",
        text: trimJournalText(
          task === undefined ? "A task is done" : `#${task.number} ${task.title} done`,
        ),
      });
    }
  }
  for (const item of input.answered) {
    if (item.answeredAt === null) continue;
    entries.push({
      at: item.answeredAt,
      kind: "decision",
      text: trimJournalText(
        `Decided on ${label(item.taskId)}: ${item.question} → ${item.answer ?? ""}`,
      ),
    });
  }
  for (const sitrep of input.sitreps) {
    const firstLine = sitrep.body
      ?.split("\n")
      .find((line) => line.trim() !== "")
      ?.trim();
    if (firstLine === undefined) continue;
    entries.push({ at: sitrep.createdAt, kind: "sitrep", text: trimJournalText(firstLine) });
  }
  return entries
    .toSorted((a, b) => isoMillis(b.at) - isoMillis(a.at))
    .slice(0, input.limit ?? JOURNAL_LIMIT);
}

/**
 * Picks the PM's model when neither the project nor the server sets a default:
 * the first enabled, installed, ready provider, using its default model when listed.
 */
export function pickManagerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const usable = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      isProviderAvailable(provider) &&
      provider.models.length > 0,
  );
  const provider = usable[0];
  if (provider === undefined) return null;
  const preferred = DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  const model =
    preferred !== undefined && provider.models.some((candidate) => candidate.slug === preferred)
      ? preferred
      : provider.models[0]!.slug;
  return { instanceId: provider.instanceId, model };
}

export type ProjectTeamRole =
  | { readonly type: "pm"; readonly projectId: ProjectId }
  /** The workspace Director; projectId is its hidden system project, which holds epics. */
  | { readonly type: "director"; readonly projectId: ProjectId }
  | { readonly type: "lead"; readonly projectId: ProjectId; readonly taskId: ProjectTaskId }
  | { readonly type: "none" };

/**
 * Resolves a thread's team role from storage alone, for callers that cannot
 * depend on ProjectTeamService (it sits above the orchestration runtime).
 */
export const roleOfThread = (
  threadId: ThreadId,
): Effect.Effect<
  ProjectTeamRole,
  ProjectTeamRepositoryError,
  ProjectTeamRepository.ProjectTeamRepository
> =>
  Effect.gen(function* () {
    const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
    const manager = yield* repository.getManagerByThreadId(threadId);
    if (Option.isSome(manager)) {
      return {
        type: manager.value.kind === "director" ? "director" : "pm",
        projectId: manager.value.projectId,
      };
    }
    const task = yield* repository.findTaskByLeadThreadId(threadId);
    if (Option.isSome(task)) {
      return { type: "lead", projectId: task.value.projectId, taskId: task.value.id };
    }
    return { type: "none" };
  });

/** Starts a task lead as a delegated task of the calling PM thread. */
export type DelegateTaskLead = (
  input: OrchestratorMcpDelegateTaskInput,
) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;

/** A child the step started, as delegate_task reports it. */
export interface DelegatedChild {
  readonly childThreadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string | null;
}

/**
 * Starts a lead's step as a delegated task. `onChildCreated` runs once the child thread
 * exists and before a mode=wait call blocks, so the child is linked before it acts.
 */
export type DelegateStep = (
  input: OrchestratorMcpDelegateTaskInput,
  onChildCreated?: (child: DelegatedChild) => Effect.Effect<void>,
) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;

/** Starts the task log note pm_nudge leaves; the daily limit reads it back. */
export const PM_NUDGE_NOTE_PREFIX = "Director nudged the PM: ";
/** pm_nudge sends one message per task within this window. */
export const PM_NUDGE_INTERVAL_MS = 24 * 60 * MINUTE_MS;
/** Recent closed Director cards read to tell whether a nudge relays a new answer. */
const PM_NUDGE_ANSWER_LOOKBACK = 50;

/** The workspace's goal alignment as the Director's goal check reads it. */
export interface GoalAlignmentReport {
  readonly director: ProjectTeamRepository.ProjectManagerRecord;
  readonly goals: ReadonlyArray<WorkspaceGoal>;
  readonly alignment: WorkspaceGoalAlignment;
  /** Key, title and project title of every live task, epics included. */
  readonly tasks: ReadonlyMap<
    string,
    { readonly key: string; readonly title: string; readonly projectTitle: string }
  >;
}

/** A task as goal alignment reads it, with its project's open cards. */
function toAlignableTask(
  task: ProjectTask,
  openAttention: ReadonlyArray<ProjectAttentionItem>,
): AlignableTask {
  const cards = openAttention.filter((item) => item.taskId === task.id);
  return {
    id: task.id,
    projectId: task.projectId,
    parentTaskId: task.parentTaskId,
    waitsOn: task.waitsOn,
    stage: task.stage,
    openQuestion: cards.length > 0,
    openBlocker: cards.some((item) => item.kind === "blocker"),
  };
}

export function toTaskBrief(
  task: ProjectTask,
  signals: ProjectTaskStatusSignals = storedTaskStatusSignals(task),
): ProjectTaskBrief {
  return {
    id: task.id,
    number: task.number,
    title: task.title,
    stage: task.stage,
    lastOutcome: task.lastOutcome,
    leadThreadId: task.leadThreadId,
    prUrl: task.prUrl,
    nudgeCount: task.nudgeCount,
    waitsOn: task.waitsOn,
    stageChangedAt: task.stageChangedAt,
    phase: projectTaskPhase(task.stage),
    iterateRound: task.iterateRound,
    shipRound: task.shipRound,
    status: resolveProjectTaskStatus({ ...task, ready: task.ready !== null }, signals),
  };
}

/** Counts per user-facing status, every status included. */
export function countTaskStatuses(
  briefs: ReadonlyArray<Pick<ProjectTaskBrief, "status">>,
): Record<ProjectTaskStatus, number> {
  const counts = Object.fromEntries(
    ProjectTaskStatus.literals.map((status) => [status, 0]),
  ) as Record<ProjectTaskStatus, number>;
  for (const brief of briefs) counts[brief.status] += 1;
  return counts;
}

/** The title a PM thread had before PMs had names; such threads take the persona's name. */
export const legacyManagerTitle = (projectTitle: string): string => `${projectTitle} PM`;

/** Short text for the PM's latest logged action, such as "started #7 Sidebar cleanup". */
export function describeManagerAction(
  event: Pick<ProjectTaskEvent, "kind" | "body">,
  taskRef: Pick<ProjectTask, "number" | "title"> | null,
): string {
  // A bare "#7" means nothing to someone who hasn't followed the threads.
  const task = taskRef === null ? "a task" : `#${taskRef.number} ${taskRef.title}`;
  switch (event.kind) {
    case "created":
      return `created ${task}`;
    case "stage_changed": {
      const [from, to] = event.body.split(" → ").map((part) => part.trim());
      if (from === "inbox" && to === "planning") return `started ${task}`;
      if (to === "cancelled") return `cancelled ${task}`;
      if (to === "done") return `closed ${task}`;
      if (to === "blocked") return `blocked ${task}`;
      return to === undefined || to.length === 0 ? `moved ${task}` : `moved ${task} to ${to}`;
    }
    case "nudge":
      return `nudged ${task}`;
    case "note":
      return event.body.startsWith("Nudge limit reached")
        ? `escalated ${task}`
        : `noted on ${task}`;
    case "summary":
      return `updated ${task}`;
    case "outcome":
      return `recorded an outcome for ${task}`;
    case "preference_changed":
      return event.body.startsWith(AFK_EVENT_PREFIX) ||
        event.body.startsWith(LEGACY_AUTO_APPROVE_PLANS_EVENT_PREFIX)
        ? "changed AFK"
        : "changed the sitrep interval";
    case "afk_answer":
      return `auto-answered a question for ${task} (AFK)`;
    case "model_step":
      return `ran a step of ${task}`;
  }
}

/** Journal text for turning AFK on or off. */
export const AFK_EVENT_PREFIX = "AFK";
/** Journal prefix used before AFK replaced "Auto-approve plans". */
const LEGACY_AUTO_APPROVE_PLANS_EVENT_PREFIX = "Auto-approve plans";

export function afkEventBody(setting: ProjectTeamSettings["afk"]): string {
  if (setting === undefined) return `${AFK_EVENT_PREFIX} turned off by you`;
  return setting.until === null
    ? `${AFK_EVENT_PREFIX} turned on by you until you turn it off`
    : `${AFK_EVENT_PREFIX} turned on by you until ${setting.until}`;
}

export function specChangedText(input: {
  readonly task: Pick<ProjectTask, "number" | "title">;
  readonly cardVersion: number | null;
  readonly version: number;
  readonly changedBy: "pm" | "user";
}): string {
  const who = input.changedBy === "user" ? "The user" : "The PM";
  const card = input.cardVersion === null ? "your plan" : `your plan (spec v${input.cardVersion})`;
  return `${AttentionRouter.SPEC_CHANGED_PREFIX} ${who} changed the spec of #${input.task.number} ${input.task.title} to v${input.version} while ${card} waited for approval, so that approval card is closed and the task is back in planning. Read the spec with task_spec_read, update the plan if needed, and ask for approval again.`;
}

export function autoApprovedPlanText(task: Pick<ProjectTask, "number" | "title">): string {
  return `${AttentionRouter.AUTO_APPROVED_PLAN_PREFIX} Your plan for #${task.number} ${task.title} → Approve and start. The task is now running; go on with the todos, and record the assumptions you make.`;
}

/** What the PM and running leads hear when the user turns AFK on or off. */
export function afkChangedText(setting: ProjectTeamSettings["afk"]): string {
  if (setting === undefined) {
    return `${AttentionRouter.AFK_NOTICE_PREFIX} The user turned AFK off and is back. Questions wait for the user again.`;
  }
  const until = setting.until === null ? "until they turn it off" : `until ${setting.until}`;
  return `${AttentionRouter.AFK_NOTICE_PREFIX} The user turned AFK on ${until}. ${AFK_AGENT_RULE}`;
}

export interface PersonaPatch {
  readonly name?: string | undefined;
  readonly avatar?: ProjectManagerAvatar | undefined;
  readonly voice?: ProjectManagerVoice | undefined;
  readonly voiceCustom?: string | undefined;
}

const hasPersonaChange = (patch: PersonaPatch | undefined): patch is PersonaPatch =>
  patch !== undefined && Object.values(patch).some((value) => value !== undefined);

function mergePersona(base: ProjectManagerPersona, patch: PersonaPatch): ProjectManagerPersona {
  const voiceCustom = patch.voiceCustom ?? base.voiceCustom;
  return {
    name: patch.name ?? base.name,
    avatar: patch.avatar ?? base.avatar,
    voice: patch.voice ?? base.voice,
    ...(voiceCustom === undefined ? {} : { voiceCustom }),
  };
}

/**
 * The "[Persona] …" line telling a live PM what the user changed, or null when the name,
 * avatar and voice are unchanged.
 */
export function personaChangeText(
  before: ProjectManagerPersona,
  after: ProjectManagerPersona,
): string | null {
  const parts: Array<string> = [];
  if (after.name !== before.name) parts.push(`Your name is now ${after.name}.`);
  if (JSON.stringify(after.avatar) !== JSON.stringify(before.avatar)) {
    parts.push(
      after.avatar.kind === "emoji"
        ? `Your avatar is now ${after.avatar.emoji}.`
        : "Your avatar changed.",
    );
  }
  const voiceBefore = voiceText(before.voice, before.voiceCustom);
  const voiceAfter = voiceText(after.voice, after.voiceCustom);
  if (after.voice !== before.voice || voiceAfter !== voiceBefore) {
    parts.push(
      isUserWordsVoice(after.voice, after.voiceCustom)
        ? `Voice (the user's words): "${voiceAfter}".`
        : `Voice: ${voiceAfter}`,
    );
  }
  return parts.length === 0 ? null : `[Persona] ${parts.join(" ")} Use this from now on.`;
}

export class ProjectTeamService extends Context.Service<
  ProjectTeamService,
  {
    /** Returns the project's PM, creating its thread when it has none or it was deleted. */
    readonly ensureManager: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectTeamRepository.ProjectManagerRecord, ProjectTeamError>;
    readonly roleOf: (threadId: ThreadId) => Effect.Effect<ProjectTeamRole, ProjectTeamError>;

    /**
     * task_create. A PM's task starts at once through `delegate` when a slot is free;
     * without `delegate` it only lands in Todo.
     */
    readonly createTask: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskCreateInput,
      delegate?: DelegateTaskLead,
    ) => Effect.Effect<ProjectTeamTaskResult, ProjectTeamError>;
    readonly startTask: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskStartInput,
      delegate: DelegateTaskLead,
    ) => Effect.Effect<ProjectTeamTaskStartResult, ProjectTeamError>;
    readonly updateTask: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskUpdateInput,
    ) => Effect.Effect<ProjectTeamTaskResult, ProjectTeamError>;
    /**
     * task_delegate: a lead hands implement, review or fix to the role's model. The
     * server picks the target and records which model ran the step.
     */
    readonly delegateStep: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskDelegateInput,
      delegate: DelegateStep,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, ProjectTeamError>;
    /** task_spec_read: a lead reads its own task's spec; the PM reads any. */
    readonly readSpec: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskSpecReadInput,
    ) => Effect.Effect<ProjectTeamTaskSpecResult, ProjectTeamError>;
    /** task_spec_write: the agent's spec becomes the next version. */
    readonly writeSpec: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskSpecWriteInput,
    ) => Effect.Effect<ProjectTeamTaskSpecResult, ProjectTeamError>;
    /** task_todo_set: checks or unchecks one todo, as a new version. */
    readonly setTodo: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskTodoSetInput,
    ) => Effect.Effect<ProjectTeamTaskSpecResult, ProjectTeamError>;
    /** task_evidence_set: records the proof for one success criterion, as a new version. */
    readonly setEvidence: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskEvidenceSetInput,
    ) => Effect.Effect<ProjectTeamTaskSpecResult, ProjectTeamError>;
    /**
     * task_review_set: the lead records its self-review of the current diff. One that
     * is not clean starts the next Iterate round, taking an In Review task back to running.
     */
    readonly setReview: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskReviewSetInput,
    ) => Effect.Effect<ProjectTeamTaskResult, ProjectTeamError>;
    /**
     * task_ready: the Ready gate. The lead's in-review pull request passes when its checks
     * passed (or, with none, the lead's local evidence covers HEAD), no review thread is
     * open and it does not conflict. Then the server marks it ready for review and sets
     * the task's ready flag.
     */
    readonly markTaskReady: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskReadyInput,
    ) => Effect.Effect<ProjectTeamTaskResult, ProjectTeamError>;
    readonly nudgeTask: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskNudgeInput,
    ) => Effect.Effect<ProjectTeamTaskNudgeResult, ProjectTeamError>;
    readonly listTasks: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskListInput,
    ) => Effect.Effect<ProjectTeamTaskListResult, ProjectTeamError>;
    readonly readTask: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskReadInput,
    ) => Effect.Effect<ProjectTeamTaskReadResult, ProjectTeamError>;
    readonly searchTasks: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskSearchInput,
    ) => Effect.Effect<ProjectTeamTaskSearchResult, ProjectTeamError>;
    readonly teamStatus: (
      callerThreadId: ThreadId,
      input: ProjectTeamStatusInput,
    ) => Effect.Effect<ProjectTeamStatus, ProjectTeamError>;
    /** team_settings_update: the PM changes settings on the user's word. */
    readonly updateSettingsAsManager: (
      callerThreadId: ThreadId,
      input: ProjectTeamSettingsUpdateInput,
    ) => Effect.Effect<ProjectTeamSettingsResult, ProjectTeamError>;
    /** projectTeam.updateSettings RPC. */
    readonly updateSettings: (
      input: ProjectTeamUpdateSettingsInput,
    ) => Effect.Effect<ProjectTeamSettingsResult, ProjectTeamError>;

    readonly askUser: (
      callerThreadId: ThreadId,
      input: ProjectTeamAskUserInput,
    ) => Effect.Effect<ProjectTeamAttentionItemResult, ProjectTeamError>;
    readonly answerAttention: (
      callerThreadId: ThreadId,
      input: ProjectTeamAttentionAnswerInput,
    ) => Effect.Effect<ProjectTeamAttentionItemResult, ProjectTeamError>;
    /** attention_dismiss: the PM, or the lead that asked, closes a question that no longer needs an answer. */
    readonly dismissAttention: (
      callerThreadId: ThreadId,
      input: ProjectTeamAttentionDismissInput,
    ) => Effect.Effect<ProjectTeamAttentionItemResult, ProjectTeamError>;

    /** projectTeam.getTask RPC. */
    readonly getTaskDetail: (
      input: ProjectTeamTaskRefInput,
    ) => Effect.Effect<ProjectTeamTaskDetail, ProjectTeamError>;
    /** projectTeam.updateTaskSpec RPC: the user's edit becomes the next version. */
    readonly updateTaskSpec: (
      input: ProjectTeamUpdateTaskSpecInput,
    ) => Effect.Effect<ProjectTeamTaskDetail, ProjectTeamError>;
    /** projectTeam.restoreTaskSpec RPC: an old version comes back as the next version. */
    readonly restoreTaskSpec: (
      input: ProjectTeamRestoreTaskSpecInput,
    ) => Effect.Effect<ProjectTeamTaskDetail, ProjectTeamError>;
    /** projectTeam.splitTaskTodo RPC: a todo becomes its own task under this one. */
    readonly splitTaskTodo: (
      input: ProjectTeamSplitTaskTodoInput,
    ) => Effect.Effect<ProjectTeamSplitTaskTodoResult, ProjectTeamError>;
    /** projectTeam.setTaskRoleModels RPC: the user overrides the project's role models for one task. */
    readonly setTaskRoleModels: (
      input: ProjectTeamSetTaskRoleModelsInput,
    ) => Effect.Effect<ProjectTeamTaskDetail, ProjectTeamError>;

    /**
     * projectTeam.moveTask RPC: moves the task's lead between the Mac and a cloud
     * sandbox, keeping its work, plan and claude session.
     */
    readonly moveTask: (
      input: ProjectTeamMoveTaskInput,
    ) => Effect.Effect<ProjectTeamTaskDetail, ProjectTeamError>;

    /** projectTeam.answerDecision RPC: the user answered a card; goes straight to the lead. */
    readonly answerDecision: (
      input: ProjectTeamAnswerDecisionInput,
    ) => Effect.Effect<ProjectTeamAttentionItemResult, ProjectTeamError>;

    /**
     * projectTeam.askLead RPC: the user's question from a card's side chat, sent to the lead
     * that raised the card. Leaves the card, the task and its plan as they are.
     */
    readonly askLead: (
      input: ProjectTeamAskLeadInput,
    ) => Effect.Effect<ProjectTeamAskLeadResult, ProjectTeamError>;

    readonly listMemory: (
      callerThreadId: ThreadId,
    ) => Effect.Effect<ProjectTeamMemoryListResult, ProjectTeamError>;
    readonly writeMemory: (
      callerThreadId: ThreadId,
      input: ProjectTeamMemoryWriteInput,
    ) => Effect.Effect<ProjectTeamMemoryWriteResult, ProjectTeamError>;
    readonly deleteMemory: (
      callerThreadId: ThreadId,
      input: ProjectTeamMemoryDeleteInput,
    ) => Effect.Effect<ProjectTeamMemoryDeleteResult, ProjectTeamError>;

    /** Director only: add or change a workspace goal. */
    readonly goalWrite: (
      callerThreadId: ThreadId,
      input: ProjectTeamGoalWriteInput,
    ) => Effect.Effect<ProjectTeamGoalResult, ProjectTeamError>;
    /** Director only: link projects and tasks to a goal, or unlink them. */
    readonly goalLink: (
      callerThreadId: ThreadId,
      input: ProjectTeamGoalLinkInput,
    ) => Effect.Effect<ProjectTeamGoalResult, ProjectTeamError>;

    /** pm_nudge: the Director tells a project's PM about one stuck task, once a day per task. */
    readonly pmNudge: (
      callerThreadId: ThreadId,
      input: ProjectTeamPmNudgeInput,
    ) => Effect.Effect<ProjectTeamPmNudgeResult, ProjectTeamError>;
    /** The workspace's goal alignment, or none when there is no Director. */
    readonly goalAlignmentReport: Effect.Effect<
      Option.Option<GoalAlignmentReport>,
      ProjectTeamError
    >;

    /** projectTeam.requestSitrep RPC. */
    readonly requestSitrep: (
      input: ProjectTeamRequestSitrepInput,
    ) => Effect.Effect<ProjectTeamRequestSitrepResult, ProjectTeamError>;
    readonly attentionSnapshot: Effect.Effect<ProjectTeamAttentionSnapshot, ProjectTeamError>;
    /** One pass over every project: answers what waited past the grace period while AFK is on. */
    readonly afkSweep: Effect.Effect<void>;
    /** The current snapshot, then a fresh one after every change. */
    readonly streamAttention: Stream.Stream<ProjectTeamAttentionSnapshot, ProjectTeamError>;

    /**
     * A PM or task lead turn ended on a permission denial nothing moved past: raise a
     * blocker for the user unless that thread already has an open card. None when no
     * card was raised.
     */
    readonly raisePermissionBlocker: (input: {
      readonly threadId: ThreadId;
      readonly denial: PermissionDenial;
    }) => Effect.Effect<Option.Option<ProjectAttentionItem>, ProjectTeamError>;
    /** Records how a task lead's turn ended; failed blocks the task and raises a blocker. */
    readonly recordOutcome: (input: {
      readonly task: ProjectTask;
      readonly outcome: ProjectTaskOutcome;
      readonly detail?: string;
    }) => Effect.Effect<
      { readonly task: ProjectTask; readonly event: ProjectTaskEvent },
      ProjectTeamError
    >;
    /**
     * A watched pull request reported a failed check, new comment or conflict to the lead
     * of an in-review task: the next Ship round starts and the task is no longer Ready.
     * None when the thread leads no in-review task.
     */
    /** The usage row of a task's model session thread, or null for any other thread. */
    readonly modelSessionOf: (
      threadId: ThreadId,
    ) => Effect.Effect<ProjectTeamRepository.ProjectTaskModelRun | null, ProjectTeamError>;
    /** Adds one finished run of a model session to its task's usage. */
    readonly recordRunUsage: (
      input: ProjectTeamRepository.AddProjectTaskModelRunUsageInput,
    ) => Effect.Effect<void, ProjectTeamError>;
    readonly recordShipWake: (input: {
      readonly leadThreadId: ThreadId;
      readonly summary: string;
      /** A check failed, which counts toward the task's CI failures. */
      readonly checksFailed?: boolean;
    }) => Effect.Effect<Option.Option<ProjectTask>, ProjectTeamError>;
  }
>()("t3/projectTeam/ProjectTeamService") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /** Live status signals per task: open questions and the lead thread's state. */
  const liveTaskSignals = (
    tasks: ReadonlyArray<ProjectTask>,
    openAttention: ReadonlyArray<Pick<ProjectAttentionItem, "taskId" | "kind">>,
  ) =>
    Effect.gen(function* () {
      const asking = new Set(openAttention.map((item) => item.taskId));
      const blocked = new Set(
        openAttention.filter((item) => item.kind === "blocker").map((item) => item.taskId),
      );
      const entries = yield* Effect.forEach(
        tasks,
        (task) =>
          Effect.gen(function* () {
            const lead = task.leadThreadId;
            const finished = task.stage === "done" || task.stage === "cancelled";
            const leadRunning =
              lead === null || finished ? false : yield* isLeadBusy(threads, lead);
            const leadFailed =
              lead === null || finished || leadRunning
                ? false
                : yield* threads.getThreadShell(lead).pipe(
                    Effect.map((shell) => shell?.status === "failed"),
                    Effect.orElseSucceed(() => false),
                  );
            const signals: ProjectTaskStatusSignals = {
              openQuestion: asking.has(task.id),
              openBlocker: blocked.has(task.id),
              leadRunning,
              leadFailed,
            };
            return [task.id as string, signals] as const;
          }),
        { concurrency: 8 },
      );
      const byId = new Map(entries);
      return (task: ProjectTask) => toTaskBrief(task, byId.get(task.id));
    });
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const router = yield* AttentionRouter.AttentionRouter;
  const sitreps = yield* SitrepScheduler.SitrepScheduler;
  const finishedTasks = yield* FinishedTaskCleanup.FinishedTaskCleanup;
  const newId = yield* makeIdGenerator;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const pullRequestText = yield* PullRequestTextReader.PullRequestTextReader;
  const worktreeHeads = yield* WorktreeHeadReader.WorktreeHeadReader;
  const cloudLead = yield* CloudLeadService.CloudLeadHooks;
  const leadMoveGate = yield* LeadMoveGate.LeadMoveGate;
  const memoryHeadroom = yield* MemoryHeadroom.MemoryHeadroom;
  const shipGate = yield* PullRequestShipGate.PullRequestShipGate;

  // At boot the provider cache may still be empty, so probe once before giving up.
  const availableModelSelection = Effect.gen(function* () {
    const cached = pickManagerModelSelection(yield* providerRegistry.getProviders);
    if (cached !== null) return cached;
    const refreshed = yield* providerRegistry.refresh().pipe(Effect.timeoutOption("15 seconds"));
    return Option.isSome(refreshed) ? pickManagerModelSelection(refreshed.value) : null;
  });
  const path = yield* Path.Path;
  const directorRoot = directorWorkspaceRoot(path, serverConfig.baseDir);
  const isDirectorRoot = (workspaceRoot: string) => path.resolve(workspaceRoot) === directorRoot;
  const managerLocks = yield* KeyedLock.make<ProjectId>();
  // Prefixes belong to the whole server, so different projects share this lock.
  const taskKeyLocks = yield* KeyedLock.make<"prefixes">();
  const taskStartLocks = yield* KeyedLock.make<ProjectId>();
  // The safety cap counts leads in every project, so its check and the start it
  // admits run one at a time app-wide. Taken inside a project's start lock, never around it.
  const leadStartLock = yield* Semaphore.make(1);
  const specLocks = yield* KeyedLock.make<ProjectTaskId>();
  // Goal writes read, change and save the whole goal; parallel calls must not drop each other's changes.
  const goalLocks = yield* KeyedLock.make<"goals">();

  const roleOf: ProjectTeamService["Service"]["roleOf"] = (threadId) =>
    roleOfThread(threadId).pipe(
      Effect.provideService(ProjectTeamRepository.ProjectTeamRepository, repository),
      orTeamError("Could not read the thread's team role."),
    );

  const requireRole = <T extends "pm" | "lead" | "director">(
    callerThreadId: ThreadId,
    allowed: ReadonlyArray<T>,
    operation: string,
  ) =>
    Effect.flatMap(roleOf(callerThreadId), (role) =>
      role.type !== "none" && (allowed as ReadonlyArray<string>).includes(role.type)
        ? Effect.succeed(role as Extract<ProjectTeamRole, { readonly type: T }>)
        : Effect.fail(
            teamError(
              role.type === "none"
                ? `${operation} is only for a project's PM or task leads.`
                : role.type === "director"
                  ? `${operation} is not available to the Director: route the work to a project's PM with task_create and projectId.`
                  : `${operation} is not available to a ${role.type === "pm" ? "PM" : "task lead"}.`,
            ),
          ),
    );

  const requireManager = (projectId: ProjectId) =>
    repository.getManager(projectId).pipe(
      orTeamError("Could not read the project's PM.", projectId),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(teamError(`Project ${projectId} has no PM.`, projectId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  // Call with taskKeyLocks held, before taking any per-project settings lock.
  const reconcileTaskKeyPrefixes = Effect.gen(function* () {
    const managers = yield* repository.listManagers();
    const named = yield* Effect.forEach(managers, (manager) =>
      Effect.map(projects.get(manager.projectId), (project) => ({ manager, project })),
    );
    const assignments = allocateTaskKeyPrefixes({
      projects: named.flatMap(({ manager, project }) =>
        Option.isSome(project) && project.value.deletedAt === null
          ? [
              {
                projectId: manager.projectId,
                title: project.value.title,
                prefix: manager.settings.taskKeyPrefix,
                aliases: manager.settings.taskKeyAliases ?? [],
              },
            ]
          : [],
      ),
    });
    for (const assignment of assignments) {
      const manager = managers.find((candidate) => candidate.projectId === assignment.projectId)!;
      if (manager.settings.taskKeyPrefix === assignment.prefix) continue;
      yield* sitreps.withSettingsLock(
        manager.projectId,
        Effect.gen(function* () {
          const latest = yield* requireManager(manager.projectId);
          yield* repository.updateManagerSettings({
            projectId: manager.projectId,
            settings: {
              ...latest.settings,
              taskKeyPrefix: assignment.prefix,
              taskKeyAliases: assignment.aliases,
            },
            now: yield* nowIso,
          });
        }),
      );
      yield* router.publish(manager.projectId);
    }
  });

  const requireTask = (taskId: ProjectTaskId, projectId: ProjectId) =>
    repository.getTask(taskId).pipe(
      orTeamError("Could not read the task.", projectId),
      Effect.flatMap((task) =>
        Option.isSome(task) && task.value.projectId === projectId
          ? Effect.succeed(task.value)
          : Effect.fail(teamError(`Task ${taskId} was not found in this project.`, projectId)),
      ),
    );

  /** A task in any project: waitsOn and parents may cross projects. */
  const requireAnyTask = (taskId: ProjectTaskId, projectId: ProjectId) =>
    repository.getTask(taskId).pipe(
      orTeamError("Could not read the task.", projectId),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(teamError(`Task ${taskId} was not found.`, projectId)),
          onSome: (task) => Effect.succeed(task),
        }),
      ),
    );

  /**
   * Checks the tasks a task would wait on: they exist in some project, and none of them
   * already waits on the task, directly or through other tasks. Returns them deduplicated.
   */
  const checkWaitsOn = (
    taskId: ProjectTaskId | null,
    waitsOn: ReadonlyArray<ProjectTaskId>,
    projectId: ProjectId,
  ) =>
    Effect.gen(function* () {
      const dependencies: Array<ProjectTask> = [];
      for (const id of new Set(waitsOn)) {
        if (id === taskId) return yield* teamError("A task can't wait on itself.", projectId);
        dependencies.push(yield* requireAnyTask(id, projectId));
      }
      if (taskId === null) return dependencies;
      const seen = new Set<string>();
      const stack = dependencies.map((task) => ({ task, root: task }));
      while (stack.length > 0) {
        const { task, root } = stack.pop()!;
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        for (const next of task.waitsOn) {
          if (next === taskId) {
            return yield* teamError(
              `Waiting on #${root.number} ${root.title} would make a cycle: it already waits on this task, directly or through other tasks.`,
              projectId,
            );
          }
          const found = yield* repository
            .getTask(next)
            .pipe(orTeamError("Could not read the task.", projectId));
          if (Option.isSome(found)) stack.push({ task: found.value, root });
        }
      }
      return dependencies;
    });

  /** Checks a parent: it exists in some project and is not the task or one of its subtasks. */
  const checkParent = (
    taskId: ProjectTaskId | null,
    parentTaskId: ProjectTaskId,
    projectId: ProjectId,
  ) =>
    Effect.gen(function* () {
      if (parentTaskId === taskId) {
        return yield* teamError("A task can't be its own parent.", projectId);
      }
      const parent = yield* requireAnyTask(parentTaskId, projectId);
      const seen = new Set<string>();
      let current: ProjectTask = parent;
      while (current.parentTaskId !== null && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.parentTaskId === taskId) {
          return yield* teamError(
            `#${parent.number} ${parent.title} can't be the parent: it is already part of this task.`,
            projectId,
          );
        }
        const next = yield* repository
          .getTask(current.parentTaskId)
          .pipe(orTeamError("Could not read the task.", projectId));
        if (Option.isNone(next)) break;
        current = next.value;
      }
      return parent;
    });

  const appendEvent = (
    task: Pick<ProjectTask, "id" | "projectId">,
    kind: ProjectTaskEventKind,
    body: string,
    actorThreadId: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      return yield* repository.appendTaskEvent({
        id: ProjectTaskEventId.make(yield* newId("task-event")),
        projectId: task.projectId,
        taskId: task.id,
        kind,
        body,
        actorThreadId,
        createdAt: yield* nowIso,
      });
    });

  const setTask = (
    input: Omit<ProjectTeamRepository.UpdateProjectTaskInput, "now">,
    answeringItem?: ProjectAttentionItem,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      // Only a move into in_review/done can clear tasks waiting on this one; a new
      // parent needs the old one, whose epic stage may change.
      const before =
        (input.stage !== undefined && isDependencyCleared(input.stage)) ||
        input.parentTaskId !== undefined
          ? yield* repository.getTask(input.id)
          : Option.none<ProjectTask>();
      const updated = yield* repository.updateTask({ ...input, now });
      if (Option.isNone(updated)) return yield* teamError(`Task ${input.id} was not found.`);
      if (
        Option.isSome(before) &&
        !isDependencyCleared(before.value.stage) &&
        isDependencyCleared(updated.value.stage)
      ) {
        yield* wakeUnblockedProjects(updated.value);
      }
      // A finished cloud task's sandbox is mirrored once more and deleted, in the background.
      if (
        FinishedTaskCleanup.isFinishedStage(updated.value.stage) &&
        updated.value.location === "cloud" &&
        updated.value.leadThreadId !== null
      ) {
        yield* cloudLead
          .release(updated.value.leadThreadId)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
      }
      // A finished task's questions can no longer be answered, so close them.
      if (FinishedTaskCleanup.isFinishedStage(updated.value.stage)) {
        if (answeringItem === undefined) {
          yield* repository.supersedeOpenAttentionItems({
            taskId: updated.value.id,
            supersededAt: now,
          });
        } else {
          // Keep the cancellation card open until the stage update succeeds and its answer is saved.
          const open = yield* repository.listOpenAttentionItems({
            projectId: updated.value.projectId,
            taskId: updated.value.id,
          });
          for (const item of open) {
            if (item.id !== answeringItem.id) {
              yield* repository.supersedeAttentionItem({ id: item.id, supersededAt: now });
            }
          }
        }
      }
      // An epic's stage follows its subtasks: re-add them up when one moves or changes parent.
      const previous = Option.isSome(before) ? before.value : undefined;
      if (input.stage !== undefined || input.parentTaskId !== undefined) {
        const parents = new Set<ProjectTaskId>();
        if (updated.value.parentTaskId !== null) parents.add(updated.value.parentTaskId);
        if (input.parentTaskId !== undefined && previous?.parentTaskId) {
          parents.add(previous.parentTaskId);
        }
        for (const parentId of parents) yield* syncEpic(parentId);
      }
      return updated.value;
    });

  /**
   * Approves a plan that waits for approval while the user is AFK: the task moves to
   * running, the lead hears it, and the journal records it.
   */
  const autoApprovePlan = (task: ProjectTask) =>
    Effect.gen(function* () {
      if (task.stage !== "awaiting_approval") return task;
      const running = yield* setTask({ id: task.id, stage: "running" });
      // The lead hears it below; its open approval card records the same answer.
      const now = yield* nowIso;
      const open = yield* repository.listOpenAttentionItems({
        projectId: task.projectId,
        taskId: task.id,
      });
      for (const item of open) {
        if (item.kind !== "approval") continue;
        yield* repository.answerAttentionItem({
          id: item.id,
          answer: PLAN_APPROVAL_START,
          answeredAt: now,
          answeredBy: "afk",
        });
      }
      yield* appendEvent(running, "stage_changed", "awaiting_approval → running", null);
      yield* appendEvent(
        running,
        "afk_answer",
        afkAnswerEventBody(
          `Approve the plan for #${running.number} ${running.title}?`,
          PLAN_APPROVAL_START,
        ),
        running.leadThreadId,
      );
      if (running.leadThreadId !== null) {
        const key = `project-team:auto-approve:${yield* newId(running.id)}`;
        yield* threads.sendToThread({
          projectId: running.projectId,
          commandId: CommandId.make(key),
          threadId: running.leadThreadId,
          messageId: MessageId.make(key),
          text: autoApprovedPlanText(running),
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        });
      }
      yield* wakeReadySubtasks(
        running,
        `${yield* keyOf(running)} ${running.title}'s plan was approved with its breakdown.`,
      );
      return running;
    });

  /** The project's AFK setting when it is on now, else null. */
  const activeAfk = (settings: ProjectTeamSettings) =>
    Effect.map(nowIso, (now) => {
      const setting = afkSetting(settings);
      return afkActive(setting, Date.parse(now)) ? (setting ?? null) : null;
    });

  /**
   * While the user is AFK, answers what has waited longer than the grace period: plan
   * approvals ("Approve and start") and decision cards (the recommended option, else the
   * first, else the AFK free-form reply). Blockers always wait for the user.
   */
  const afkSweepProject = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    Effect.gen(function* () {
      if ((yield* activeAfk(manager.settings)) === null) return;
      const projectId = manager.projectId;
      const nowMs = isoMillis(yield* nowIso);
      const due = (at: string) => nowMs - isoMillis(at) >= AFK_GRACE_MS;
      let changed = false;
      const waitingPlans = yield* repository.listTasks({
        projectId,
        stages: ["awaiting_approval"],
      });
      for (const task of waitingPlans) {
        if (!due(task.stageChangedAt)) continue;
        yield* autoApprovePlan(task);
        changed = true;
      }
      const open = yield* repository.listOpenAttentionItems({ projectId });
      // Plan cards were answered with their tasks above; blockers wait for the user.
      for (const item of open) {
        if (item.kind !== "decision" || !due(item.createdAt)) continue;
        const answer = afkPickOption(item.options) ?? AFK_FREE_FORM_ANSWER;
        yield* router.answer({
          item,
          answer,
          senderThreadId: manager.threadId,
          answeredBy: "afk",
        });
        yield* repository.appendTaskEvent({
          id: ProjectTaskEventId.make(yield* newId("project-event")),
          projectId,
          taskId: item.taskId,
          kind: "afk_answer",
          body: afkAnswerEventBody(item.question, answer),
          actorThreadId: item.askerThreadId,
          createdAt: yield* nowIso,
        });
        changed = true;
      }
      if (changed) yield* router.publish(projectId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team AFK sweep failed", {
          projectId: manager.projectId,
          cause,
        }),
      ),
    );

  const afkSweep: ProjectTeamService["Service"]["afkSweep"] = repository.listManagers().pipe(
    Effect.flatMap((managers) => Effect.forEach(managers, afkSweepProject, { discard: true })),
    Effect.catchCause((cause) => Effect.logWarning("project team AFK sweep failed", { cause })),
  );

  /** Tells the live PM and every running lead that AFK changed; their prompts predate it. */
  const announceAfk = (
    projectId: ProjectId,
    managerThreadId: ThreadId,
    setting: ProjectTeamSettings["afk"],
    now: string,
  ) =>
    Effect.gen(function* () {
      const text = afkChangedText(setting);
      const tasks = yield* repository.listTasks({
        projectId,
        stages: SitrepScheduler.ACTIVE_TASK_STAGES,
      });
      const targets = [
        managerThreadId,
        ...tasks.flatMap((task) => (task.leadThreadId === null ? [] : [task.leadThreadId])),
      ];
      for (const threadId of targets) {
        const key = `project-team:afk:${threadId}:${now}`;
        yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId,
            messageId: MessageId.make(key),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not tell a thread that AFK changed", { threadId, cause }),
            ),
          );
      }
    });

  const activeTasks = (projectId: ProjectId) =>
    repository.listTasks({ projectId, stages: SitrepScheduler.ACTIVE_TASK_STAGES });

  const taskExecutionSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => resolveTaskExecutionSettings(settings.taskExecution)),
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.taskExecution),
  );

  const setMemoryHold = (task: ProjectTask, memoryHold: ProjectTaskMemoryHold | null) =>
    Effect.flatMap(nowIso, (now) =>
      repository.setTaskMemoryHold({ id: task.id, memoryHold, now }),
    ).pipe(orTeamError("Could not record the memory hold.", task.projectId));

  /** Notes a sitrep milestone when a stage change left nothing running. */
  const noteIdleMilestone = (projectId: ProjectId, previousStage: ProjectTaskStage) =>
    Effect.gen(function* () {
      if (!(SitrepScheduler.ACTIVE_TASK_STAGES as ReadonlyArray<string>).includes(previousStage)) {
        return;
      }
      if ((yield* activeTasks(projectId)).length === 0) yield* sitreps.noteMilestone(projectId);
    });

  /** Stores the resolved persona so a default name stays put even if the defaults change. */
  const persistPersona = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    manager.settings.persona !== undefined
      ? Effect.succeed(manager)
      : sitreps.withSettingsLock(
          manager.projectId,
          Effect.gen(function* () {
            const current = Option.getOrElse(
              yield* repository.getManager(manager.projectId),
              () => manager,
            );
            if (current.settings.persona !== undefined) return current;
            const settings = {
              ...current.settings,
              persona: resolvePersona(current.projectId, current.settings),
            };
            const updated = yield* repository.updateManagerSettings({
              projectId: current.projectId,
              settings,
              now: yield* nowIso,
            });
            return Option.getOrElse(updated, () => ({ ...current, settings }));
          }),
        );

  const renameManagerThread = (threadId: ThreadId, title: string) =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`project-team:rename-pm:${yield* newId(threadId)}`),
        threadId,
        title,
      });
    });

  /** Brings an existing PM thread up to date: stored persona, named title, not archived. */
  const reviveManager = (
    existing: ProjectTeamRepository.ProjectManagerRecord,
    shell: { readonly title: string; readonly archivedAt: unknown },
    projectTitle: string,
  ) =>
    Effect.gen(function* () {
      const manager = yield* persistPersona(existing);
      const persona = resolvePersona(manager.projectId, manager.settings);
      let changed = manager !== existing;
      if (shell.title === legacyManagerTitle(projectTitle) && shell.title !== persona.name) {
        yield* renameManagerThread(manager.threadId, persona.name);
        changed = true;
      }
      if (shell.archivedAt !== null) {
        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`project-team:unarchive-pm:${yield* newId(manager.threadId)}`),
          threadId: manager.threadId,
        });
        changed = true;
      }
      if (changed) yield* router.publish(manager.projectId);
      return manager;
    });

  const ensureManager: ProjectTeamService["Service"]["ensureManager"] = (projectId) =>
    taskKeyLocks.withLock(
      "prefixes",
      managerLocks
        .withLock(
          projectId,
          Effect.gen(function* () {
            const project = yield* projects.get(projectId);
            if (Option.isNone(project)) {
              return yield* teamError(`Project ${projectId} was not found.`, projectId);
            }
            const kind: ProjectManagerKind = isDirectorRoot(project.value.workspaceRoot)
              ? "director"
              : "pm";
            const existing = yield* repository.getManager(projectId);
            if (Option.isSome(existing)) {
              const shell = yield* threads.getThreadShell(existing.value.threadId);
              if (shell !== null && shell.deletedAt === null) {
                return yield* reviveManager(existing.value, shell, project.value.title);
              }
            }
            const defaults =
              kind === "director"
                ? { ...DEFAULT_PROJECT_TEAM_SETTINGS, persona: DIRECTOR_PERSONA }
                : DEFAULT_PROJECT_TEAM_SETTINGS;
            const persona = resolvePersona(
              projectId,
              Option.isSome(existing) ? existing.value.settings : defaults,
            );
            const settings = resolveProjectSettings(
              yield* serverSettings.getSettings,
              projectId,
            ).settings;
            const modelSelection: ModelSelection = project.value.defaultModelSelection ??
              settings.defaultModelSelection ??
              (yield* availableModelSelection) ?? {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              };
            const threadId = ThreadId.make(yield* newId("project-pm"));
            yield* threads.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`project-team:create-pm:${threadId}`),
              threadId,
              projectId,
              title: persona.name,
              modelSelection,
              runtimeMode: settings.defaultRuntimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdBy: "system",
              creationSource: "server",
            });
            // A replaced PM keeps the stored settings: persona, on/off, interval and the rest.
            const upserted = yield* sitreps.withSettingsLock(
              projectId,
              Effect.gen(function* () {
                const stored = yield* repository.getManager(projectId);
                const kept = Option.isSome(stored) ? stored.value.settings : defaults;
                return yield* repository.upsertManager({
                  projectId,
                  threadId,
                  kind,
                  settings: { ...kept, persona: resolvePersona(projectId, kept) },
                  now: yield* nowIso,
                });
              }),
            );
            const manager = yield* persistPersona(upserted);
            // A sitrep the old PM thread was writing will never be posted.
            if (Option.isSome(existing)) yield* sitreps.abandonPending(projectId);
            yield* router.publish(projectId);
            return manager;
          }).pipe(orTeamError("Could not set up the project's PM.", projectId)),
        )
        .pipe(
          Effect.tap(() => reconcileTaskKeyPrefixes),
          Effect.flatMap(() => requireManager(projectId)),
          orTeamError("Could not set up the project's PM.", projectId),
        ),
    );

  /** Refuses a new task whose title matches an open task's: that work belongs there. */
  const refuseDuplicate = (projectId: ProjectId, title: string, callerProjectId: ProjectId) =>
    Effect.gen(function* () {
      const duplicate = findOpenDuplicate(yield* repository.listTasks({ projectId }), title);
      if (duplicate === undefined) return;
      const manager = yield* requireManager(projectId);
      const key = formatTaskKey(
        yield* taskKeyPrefixFor(projectId, manager.settings),
        duplicate.number,
      );
      return yield* teamError(
        `${key} "${duplicate.title}" is already open (${duplicate.stage}). Add this to it with task_nudge(taskId, note, scope: true) instead, or give the new task a title that says how it differs.`,
        callerProjectId,
      );
    });

  /**
   * A lead drafts a subtask of its own task. It stays in the inbox until the user
   * approves the parent's plan, which approves the whole breakdown at once.
   */
  const draftSubtask = (
    callerThreadId: ThreadId,
    role: Extract<ProjectTeamRole, { readonly type: "lead" }>,
    input: ProjectTeamTaskCreateInput,
  ) =>
    Effect.gen(function* () {
      if (input.projectId !== undefined && input.projectId !== role.projectId) {
        return yield* teamError(
          "A task lead drafts subtasks in its own project only; leave projectId out.",
          role.projectId,
        );
      }
      if (input.parentTaskId !== undefined && input.parentTaskId !== role.taskId) {
        return yield* teamError(
          "A task lead drafts subtasks of its own task only; leave parentTaskId out.",
          role.projectId,
        );
      }
      const parent = yield* requireTask(role.taskId, role.projectId);
      if (FinishedTaskCleanup.isFinishedStage(parent.stage)) {
        return yield* teamError(`#${parent.number} is ${parent.stage}.`, role.projectId);
      }
      yield* refuseDuplicate(role.projectId, input.title, role.projectId);
      const waitsOn = (yield* checkWaitsOn(null, input.waitsOn ?? [], role.projectId)).map(
        (task) => task.id,
      );
      const task = yield* repository.createTask({
        id: ProjectTaskId.make(yield* newId("task")),
        projectId: role.projectId,
        title: input.title,
        request: input.request,
        waitsOn,
        parentTaskId: parent.id,
        now: yield* nowIso,
        author: "agent",
        authorThreadId: callerThreadId,
      });
      yield* appendEvent(task, "created", task.title, callerThreadId);
      yield* appendEvent(
        task,
        "note",
        `Drafted by #${parent.number}'s lead. It starts once the user approves #${parent.number}'s plan, which covers its whole breakdown.`,
        callerThreadId,
      );
      yield* router.publish(role.projectId);
      return { task };
    });

  const createTask: ProjectTeamService["Service"]["createTask"] = (
    callerThreadId,
    input,
    delegate,
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "director", "lead"], "task_create");
      if (role.type === "lead") return yield* draftSubtask(callerThreadId, role, input);
      const projectId = yield* taskCreateProject(role, input.projectId);
      const goal = input.goal?.trim() ?? "";
      const verification = input.verification?.trim() ?? "";
      if (goal.length === 0 || verification.length === 0) {
        return yield* teamError(
          "task_create needs goal and verification: the end state and how to check it, in the user's language. They go into the request the task lead plans from.",
          role.projectId,
        );
      }
      const intake = input.intake?.trim() ?? "";
      if (intake.length === 0) {
        return yield* teamError(
          "task_create needs intake: one line on why this is new work. If it is a question, answer it or ask a read-only subagent. If it belongs to an open task, add it there with task_nudge(scope: true).",
          role.projectId,
        );
      }
      yield* refuseDuplicate(projectId, input.title, role.projectId);
      const waitsOn = (yield* checkWaitsOn(null, input.waitsOn ?? [], projectId)).map(
        (task) => task.id,
      );
      if (input.parentTaskId !== undefined) {
        yield* checkParent(null, input.parentTaskId, projectId);
      }
      if (input.goalId !== undefined && role.type !== "director") {
        return yield* teamError(
          "Only the Director links tasks to goals; leave goalId out.",
          role.projectId,
        );
      }
      if (input.goalId !== undefined) {
        const goal = yield* requireGoal(input.goalId, role.projectId);
        if (goal.status !== "active") {
          return yield* teamError(`Goal ${goal.id} is ${goal.status}.`, role.projectId);
        }
      }
      // The task goes straight to Todo; the user shapes its scope at plan approval.
      const task = yield* repository.createTask({
        id: ProjectTaskId.make(yield* newId("task")),
        projectId,
        title: input.title,
        request: `${input.request}\n\nGoal: ${goal}\n\nVerification: ${verification}`,
        waitsOn,
        parentTaskId: input.parentTaskId,
        now: yield* nowIso,
        author: "pm",
        authorThreadId: callerThreadId,
      });
      yield* appendEvent(task, "created", task.title, callerThreadId);
      yield* appendEvent(task, "note", `Intake: ${intake}`, callerThreadId);
      if (input.goalId !== undefined) {
        const goalId = input.goalId;
        yield* goalLocks.withLock(
          "goals",
          Effect.gen(function* () {
            const goal = yield* requireGoal(goalId, role.projectId);
            yield* repository.saveWorkspaceGoal({
              ...goal,
              links: [...goal.links, { projectId: task.projectId, taskId: task.id }],
              updatedAt: yield* nowIso,
            });
          }),
        );
      }
      if (task.parentTaskId !== null) {
        yield* syncEpic(task.parentTaskId);
      }
      yield* router.publish(task.projectId);
      if (task.projectId !== role.projectId) {
        // The Director routed it: that project's PM starts it.
        yield* wakeManagerWith(
          task.projectId,
          `project-team:director-added:${task.id}`,
          directorAddedTaskWakeText(yield* keyOf(task), task),
        );
        return { task };
      }
      // A PM's task starts right away; without a free slot it waits in Todo.
      if (role.type !== "pm" || delegate === undefined) return { task };
      return yield* startTask(callerThreadId, { taskId: task.id }, delegate).pipe(
        Effect.map((started): ProjectTeamTaskResult => ({ task: started.task })),
        // Only a full slot or an unfinished dependency means "wait"; other failures surface.
        Effect.catch((failure) =>
          Effect.gen(function* () {
            const current = yield* requireTask(task.id, task.projectId);
            const reason = current.stage === "inbox" ? yield* startWaitReason(current) : null;
            if (reason === null) return yield* Effect.fail(failure);
            const waiting = `Waiting in Todo: ${reason}`;
            yield* appendEvent(current, "note", waiting, callerThreadId);
            return { task: current, waiting };
          }),
        ),
      );
    }).pipe(orTeamError("Could not create the task."));

  /** Why an inbox task cannot start yet: every lead slot is busy or a dependency is unfinished. */
  const startWaitReason = (task: ProjectTask) =>
    Effect.gen(function* () {
      // The cap is app-wide: leads running on this Mac in every project count.
      const running = yield* activeLocalLeads(repository);
      const limit = (yield* taskExecutionSettings).maxConcurrentSessions;
      if (running >= limit) {
        return `${running} of ${limit} task leads are already running.`;
      }
      for (const dependencyId of task.waitsOn) {
        const dependency = yield* requireAnyTask(dependencyId, task.projectId);
        if (!isDependencyCleared(dependency.stage)) {
          return `#${task.number} waits on #${dependency.number}, which is ${dependency.stage}.`;
        }
      }
      if (task.memoryHold === "waiting") {
        return `${MEMORY_WAIT_REASON}: #${task.number} starts by itself once the Mac has room.`;
      }
      return null;
    });

  /**
   * Where task_create adds the task: a PM's own project, or for the Director the
   * project it names (whose PM runs it), else its own project as an epic.
   */
  const taskCreateProject = (
    role: Extract<ProjectTeamRole, { readonly type: "pm" | "director" }>,
    requested: ProjectId | undefined,
  ) =>
    Effect.gen(function* () {
      if (requested === undefined || requested === role.projectId) return role.projectId;
      if (role.type !== "director") {
        return yield* teamError(
          "A PM adds tasks to its own project only; leave projectId out.",
          role.projectId,
        );
      }
      const manager = yield* repository
        .getManager(requested)
        .pipe(orTeamError("Could not read the project's PM.", requested));
      if (Option.isNone(manager) || manager.value.kind !== "pm") {
        return yield* teamError(
          `Project ${requested} has no PM. Pick a projectId from team_status.`,
          role.projectId,
        );
      }
      return requested;
    });

  /** Moves an epic in the Director's project to the stage its subtasks add up to. */
  const syncEpic = (epicId: ProjectTaskId): Effect.Effect<void, ProjectTeamError> =>
    Effect.gen(function* () {
      const epic = yield* repository.getTask(epicId);
      if (Option.isNone(epic)) return;
      const manager = yield* repository.getManager(epic.value.projectId);
      if (Option.isNone(manager) || manager.value.kind !== "director") return;
      const children = yield* repository.listChildTasks(epicId);
      const stage = epicStage(children.map((child) => child.stage));
      if (stage === epic.value.stage) return;
      const updated = yield* setTask({ id: epicId, stage });
      yield* appendEvent(updated, "stage_changed", `${epic.value.stage} → ${stage}`, null);
      yield* router.publish(updated.projectId);
    }).pipe(orTeamError("Could not update the epic."));

  /** Stores the model a delegate_task call ran a role on, and logs it. */
  const recordModelStep = (
    task: ProjectTask,
    role: ProjectTaskModelRole,
    ran: Pick<OrchestratorMcpDelegateTaskResult, "providerInstanceId" | "model">,
    actorThreadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const updated = yield* repository.recordModelStep({
        id: task.id,
        role,
        step: { providerInstanceId: ran.providerInstanceId, model: ran.model, at: yield* nowIso },
      });
      yield* appendEvent(
        task,
        "model_step",
        modelStepEventBody(role, ran.providerInstanceId, ran.model),
        actorThreadId,
      );
      return Option.getOrElse(updated, () => task);
    });

  const delegateStep: ProjectTeamService["Service"]["delegateStep"] = (
    callerThreadId,
    input,
    delegate,
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["lead"], "task_delegate");
      const task = yield* requireTask(role.taskId, role.projectId);
      if (FinishedTaskCleanup.isFinishedStage(task.stage)) {
        return yield* teamError(`#${task.number} is finished.`, role.projectId);
      }
      const manager = yield* requireManager(role.projectId);
      const resolved = resolveRoleModels(task.roleModels, manager.settings.roleModels);
      // A cloud task's children share the lead's checkout, so they run in its sandbox.
      const model =
        task.location === "cloud" && input.isolation !== "worktree"
          ? yield* cloudStepModel(task, input.role, resolved[input.role], resolved.plan)
          : resolved[input.role];
      const key = yield* keyOf(task);
      // Links the child before it acts: its usage row, and for a review its reviewer
      // session. Opening the row again (a retry, or the call after the hook) is a no-op.
      const linkChild = (child: DelegatedChild) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          yield* repository.startModelRun({
            taskId: task.id,
            threadId: child.childThreadId,
            role: input.role,
            providerInstanceId: child.providerInstanceId,
            model: child.model,
            startedAt,
            countsFixRound: input.role === "fix",
          });
          if (input.role === "review") {
            // The review session records its own result with task_review_set.
            yield* repository.addTaskSession({
              taskId: task.id,
              threadId: child.childThreadId,
              role: "reviewer",
              createdAt: startedAt,
            });
          }
        }).pipe(orTeamError("Could not record the step.", role.projectId));
      const result = yield* delegate(
        {
          task: input.task,
          title: input.title ?? `${key} ${input.role}`,
          role: DELEGATE_ROLE[input.role],
          ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
          ...(model === null ? {} : { target: toDelegateTarget(model.target) }),
        },
        (child) =>
          linkChild(child).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not link a delegated step before it ran", { cause }),
            ),
          ),
      ).pipe(
        Effect.mapError((failure) =>
          teamError(
            `Could not start the ${input.role} step for #${task.number}: ${failure.message}`,
            role.projectId,
          ),
        ),
      );
      yield* recordModelStep(task, input.role, result, callerThreadId);
      yield* linkChild(result);
      yield* router.publish(role.projectId);
      return result;
    }).pipe(orTeamError("Could not delegate the step."));

  /**
   * The model a step of a cloud task runs on, in the lead's sandbox. Codex runs
   * there only with the cloud Codex login; otherwise the step moves to the plan
   * model, which the task's notes and model steps show. A lasting failure (no
   * login, or one codex rejects) moves this task's implement and fix (or its
   * review) for good; a passing one (the login busy elsewhere) only this step.
   */
  const cloudStepModel = (
    task: ProjectTask,
    role: ProjectTaskDelegatedRole,
    model: ResolvedRoleModels[ProjectTaskModelRole],
    plan: ResolvedRoleModels["plan"],
  ) =>
    Effect.gen(function* () {
      if (model === null) return model;
      const providers = yield* providerRegistry.getProviders;
      const driver = providers.find(
        (provider) => provider.instanceId === model.target.providerInstanceId,
      )?.driver;
      if (driver !== "codex") return model;
      const shell =
        task.leadThreadId === null
          ? null
          : yield* threads.getThreadShell(task.leadThreadId).pipe(Effect.orElseSucceed(() => null));
      const check =
        shell?.worktreePath == null
          ? { ok: false as const, reason: "the lead has no worktree", transient: true }
          : yield* cloudLead.checkCodex(shell.worktreePath);
      if (check.ok) return model;
      const target: ProjectTaskModelTarget | null =
        plan?.target ??
        (shell === null
          ? null
          : {
              providerInstanceId: shell.modelSelection.instanceId,
              model: shell.modelSelection.model,
            });
      if (target === null) return model;
      const modelName = `${target.providerInstanceId} · ${target.model}`;
      if (check.transient) {
        yield* appendEvent(
          task,
          "note",
          `클라우드에서 지금 Codex를 쓸 수 없어서 이번 ${STEP_LABEL[role]} 단계만 ${modelName}(으)로 돌려요. 이유: ${check.reason}`,
          null,
        );
        return { target, source: "task" as const };
      }
      const updated = yield* repository.setTaskRoleModels({
        id: task.id,
        roleModels: applyRoleModelsPatch(
          task.roleModels,
          role === "review" ? { review: target } : { implement: target, fix: target },
        ),
        now: yield* nowIso,
      });
      yield* appendEvent(
        Option.getOrElse(updated, () => task),
        "note",
        `클라우드에서 Codex를 쓸 수 없어서 이 태스크만 ${role === "review" ? "리뷰" : "구현·수정"} 모델을 ${modelName}(으)로 바꿨어요. 이유: ${check.reason}`,
        null,
      );
      return { target, source: "task" as const };
    });

  const startTask: ProjectTeamService["Service"]["startTask"] = (callerThreadId, input, delegate) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm"], "task_start");
      return yield* taskStartLocks.withLock(
        role.projectId,
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId, role.projectId);
          if (task.stage !== "inbox") {
            return yield* teamError(`#${task.number} is already ${task.stage}.`, role.projectId);
          }
          const manager = yield* requireManager(role.projectId);
          const active = yield* activeTasks(role.projectId);
          const execution = yield* taskExecutionSettings;
          const limit = execution.maxConcurrentSessions;
          // The cap is app-wide: leads running on this Mac in every project count.
          const running = yield* activeLocalLeads(repository);
          if (running >= limit) {
            return yield* teamError(
              `#${task.number} stays in the inbox: ${running} of ${limit} task leads are already running.`,
              role.projectId,
            );
          }
          for (const dependencyId of task.waitsOn) {
            const dependency = yield* requireAnyTask(dependencyId, role.projectId);
            if (!isDependencyCleared(dependency.stage)) {
              return yield* teamError(
                `#${task.number} waits on #${dependency.number}, which is ${dependency.stage}.`,
                role.projectId,
              );
            }
          }
          const coveredBy = yield* breakdownCoverage(task);
          if (coveredBy === null && task.parentTaskId !== null && (yield* isLeadDraft(task))) {
            return yield* teamError(
              `#${task.number} is a drafted subtask. It starts once the user approves its parent's plan, which covers the whole breakdown.`,
              role.projectId,
            );
          }
          const memory = yield* repository.listMemory(role.projectId);
          const key = formatTaskKey(
            yield* taskKeyPrefixFor(role.projectId, manager.settings),
            task.number,
          );
          const spec = yield* latestSpec(task);
          // A task whose plan was already approved resumes straight into the work.
          const resume = task.planSummary !== null;
          const userLanguage = resolveUserLanguage(
            task.request,
            yield* recentUserWords(manager.threadId),
          );
          // A restart must not reuse the first lead's request id, or it gets that lead back.
          const earlierSessions = (yield* repository.listTaskSessions(task.id)).length;
          const roleModels = resolveRoleModels(task.roleModels, manager.settings.roleModels);
          // A plan model the user picked wins over the PM's choice.
          const leadTarget =
            roleModels.plan === null ? input.target : toDelegateTarget(roleModels.plan.target);
          // The user's execution-location setting and the Mac's free memory pick the place.
          const headroom = (yield* memoryHeadroom.checkFresh).headroom;
          const admission = admitTaskLead({
            active: running,
            cap: limit,
            policy: execution.location,
            headroom,
            requested: input.location,
          });
          const waitInTodo = Effect.gen(function* () {
            if (task.memoryHold !== "waiting") {
              yield* setMemoryHold(task, "waiting");
              yield* appendEvent(
                task,
                "note",
                `${MEMORY_WAIT_REASON}: 메모리 여유가 생기면 시작해요.`,
                null,
              );
              yield* router.publish(role.projectId);
            }
          });
          /**
           * Holds the task in Todo. Only a wait while memory is short stalls it:
           * a wait for start spacing is deliberate pacing.
           */
          const waitForMemory = (memoryShort: boolean) =>
            Effect.gen(function* () {
              yield* waitInTodo;
              if (memoryShort) {
                const at = yield* nowIso;
                yield* repository
                  .setTaskMemoryStall({ id: task.id, stalling: true, at })
                  .pipe(orTeamError("Could not record the memory stall.", task.projectId));
              }
            });
          if (admission.type === "wait") {
            if (admission.memory) yield* waitForMemory(headroom !== "ok");
            return yield* teamError(
              `#${task.number} stays in the inbox: ${admission.reason} It starts once the Mac has room; do not retry it.`,
              role.projectId,
            );
          }
          /**
           * Every local start claims the shared start gate: a fresh ok reading and
           * time since the last local start for its memory to show. When it cannot,
           * the task waits for memory and the governor has the PM start it later.
           */
          const claimLocalStart = (why: (claim: MemoryHeadroom.StartClaim) => string) =>
            Effect.gen(function* () {
              const claim = yield* memoryHeadroom.claimStart(MemoryHeadroom.START_SPACING_MS);
              if (claim.type === "started") return;
              yield* waitForMemory(claim.type === "short");
              return yield* teamError(
                `#${task.number} stays in the inbox: ${why(claim)} It starts by itself once the Mac has room; do not retry it.`,
                role.projectId,
              );
            });
          const notNow = (claim: MemoryHeadroom.StartClaim) =>
            claim.type === "spaced"
              ? `another session started on this Mac moments ago, and its memory has not shown yet (${MEMORY_WAIT_REASON}).`
              : `${MEMORY_WAIT_REASON}.`;
          if (admission.location === "local") yield* claimLocalStart(notNow);
          const delegateLead = (location: ExecutionLocation, requestSuffix: string) =>
            Effect.gen(function* () {
              return yield* delegate({
                task: buildTaskLeadPrompt({
                  task: { ...task, location },
                  key,
                  spec,
                  resume,
                  memory,
                  otherTasks: active,
                  ...((yield* activeAfk(manager.settings)) === null
                    ? {}
                    : { afkRule: AFK_AGENT_RULE }),
                  ...(userLanguage === null ? {} : { userLanguage }),
                  ...(coveredBy === null
                    ? {}
                    : { coveredBy: { key: yield* keyOf(coveredBy), title: coveredBy.title } }),
                  roleModels,
                }),
                title: `${key} ${task.title}`,
                role: "implementation",
                isolation: "worktree",
                mode: "async",
                clientRequestId:
                  earlierSessions === 0
                    ? `task-start:${task.id}${requestSuffix}`
                    : `task-start:${task.id}:${earlierSessions + 1}${requestSuffix}`,
                ...(leadTarget === undefined ? {} : { target: leadTarget }),
                // Always explicit, so delegate_task never re-places a lead the
                // admission already placed (it may move an unplaced child to the cloud).
                location,
              }).pipe(
                Effect.mapError((failure) =>
                  teamError(
                    `Could not start a task lead for #${task.number}: ${failure.message}`,
                    role.projectId,
                  ),
                ),
              );
            });
          // The setting, not the PM, sent it to the cloud: when the cloud cannot
          // take it, start here if the Mac has room, else wait for memory.
          const { lead, location, note } = yield* delegateLead(admission.location, "").pipe(
            Effect.map((lead) => ({ lead, location: admission.location, note: admission.note })),
            Effect.catch((failure) =>
              Effect.gen(function* () {
                if (admission.location !== "cloud" || input.location === "cloud") {
                  return yield* Effect.fail(failure);
                }
                yield* claimLocalStart(
                  (claim) =>
                    `the cloud could not start it (${failure.message}) and ${notNow(claim)}`,
                );
                const lead = yield* delegateLead("local", ":local");
                return { lead, location: "local" as const, note: CLOUD_FALLBACK_NOTE };
              }),
            ),
          );
          const started = yield* setTask({
            id: task.id,
            stage: "planning",
            leadThreadId: lead.childThreadId,
            location,
            // The parent's approved breakdown is this subtask's approved plan.
            ...(coveredBy === null || task.planSummary !== null
              ? {}
              : { planSummary: yield* coveredPlanSummary(task, coveredBy) }),
          });
          yield* repository.addTaskSession({
            taskId: started.id,
            threadId: lead.childThreadId,
            role: resume ? "implementer" : "lead",
            createdAt: started.stageChangedAt,
          });
          yield* appendEvent(started, "stage_changed", "inbox → planning", callerThreadId);
          if (note !== null) {
            yield* appendEvent(started, "note", note, null);
          }
          if (task.memoryHold != null) yield* setMemoryHold(started, null);
          // Logged as the lead's, so the PM's latest action still reads "started".
          const withStep = yield* recordModelStep(started, "plan", lead, lead.childThreadId);
          yield* repository
            .startModelRun({
              taskId: started.id,
              threadId: lead.childThreadId,
              role: "plan",
              providerInstanceId: lead.providerInstanceId,
              model: lead.model,
              startedAt: started.stageChangedAt,
            })
            .pipe(orTeamError("Could not record the plan step.", role.projectId));
          yield* router.publish(role.projectId);
          return { task: withStep, leadThreadId: lead.childThreadId };
        }).pipe(leadStartLock.withPermits(1)),
      );
    }).pipe(orTeamError("Could not start the task."));

  /**
   * The task a spec tool acts on: a lead's own task, or the one the PM names. The
   * Director reads any task's spec and writes only its own epics'.
   */
  const specTaskFor = (
    callerThreadId: ThreadId,
    taskId: ProjectTaskId | undefined,
    tool: string,
    access: "read" | "write" = "write",
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], tool);
      const id = taskId ?? (role.type === "lead" ? role.taskId : undefined);
      if (id === undefined) return yield* teamError(`${tool} needs a taskId.`);
      if (role.type === "lead" && id !== role.taskId) {
        return yield* teamError("A task lead can only use its own task's spec.", role.projectId);
      }
      const task =
        role.type === "director" && access === "read"
          ? yield* requireAnyTask(id, role.projectId)
          : yield* requireTask(id, role.projectId);
      const author: "pm" | "lead" = role.type === "lead" ? "lead" : "pm";
      return { task, author };
    });

  const specResult = (task: ProjectTask, current: ProjectTeamTaskSpecResult["current"]) =>
    Effect.gen(function* () {
      const manager = yield* requireManager(task.projectId);
      const prefix = yield* taskKeyPrefixFor(task.projectId, manager.settings);
      return { key: formatTaskKey(prefix, task.number), current };
    });

  /**
   * A new plan version makes an open approval card for an older version stale: the card
   * closes and the task goes back to planning. A lead that did not make the change hears it.
   */
  const closeStaleApproval = (
    task: ProjectTask,
    version: ProjectTaskSpecVersion,
    changedBy: "lead" | "pm" | "user",
    actorThreadId: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      const open = yield* repository.listOpenAttentionItems({
        projectId: task.projectId,
        taskId: task.id,
      });
      const stale = open.filter(
        (item) =>
          item.kind === "approval" &&
          (item.specVersion === null || item.specVersion < version.version),
      );
      if (stale.length === 0) return;
      const now = yield* nowIso;
      for (const item of stale) {
        yield* repository.supersedeAttentionItem({ id: item.id, supersededAt: now });
      }
      const cardVersion = stale.at(-1)?.specVersion ?? null;
      const current = yield* requireTask(task.id, task.projectId);
      if (current.stage === "awaiting_approval") {
        yield* moveTaskStage(current, "planning", actorThreadId);
      }
      yield* appendEvent(
        current,
        "note",
        `Approval card${cardVersion === null ? "" : ` for v${cardVersion}`} closed: the spec moved to v${version.version}.`,
        actorThreadId,
      );
      if (changedBy !== "lead" && current.leadThreadId !== null) {
        const manager = yield* requireManager(task.projectId);
        const key = `project-team:spec-changed:${yield* newId(task.id)}`;
        yield* threads.sendToThread({
          projectId: task.projectId,
          commandId: CommandId.make(key),
          threadId: current.leadThreadId,
          messageId: MessageId.make(key),
          senderThreadId: manager.threadId,
          text: specChangedText({
            task: current,
            cardVersion,
            version: version.version,
            changedBy,
          }),
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        });
      }
      yield* router.publish(task.projectId);
    });

  /**
   * Writes the next version from the latest one; a lead's write is an agent's.
   * A plan revision closes a stale approval card; checking a todo or recording evidence does not.
   */
  const appendAgentSpec = (
    callerThreadId: ThreadId,
    task: ProjectTask,
    author: "pm" | "lead",
    note: string,
    next: (latest: ProjectTaskSpec) => Effect.Effect<ProjectTaskSpec, ProjectTeamError>,
    baseVersion?: number,
    revisesPlan = true,
  ) =>
    specLocks
      .withLock(
        task.id,
        Effect.gen(function* () {
          const latest = yield* latestSpec(task);
          if (baseVersion !== undefined && latest.version !== baseVersion) {
            return yield* teamError(
              `The spec is at v${latest.version} now, not v${baseVersion}. Read it again with task_spec_read and redo your change on top of it.`,
              task.projectId,
            );
          }
          const version = yield* repository.appendSpecVersion({
            taskId: task.id,
            spec: yield* next(latest.spec),
            author: author === "pm" ? "pm" : "agent",
            authorThreadId: callerThreadId,
            note,
            createdAt: yield* nowIso,
          });
          yield* appendEvent(task, "note", `Spec v${version.version}: ${note}`, callerThreadId);
          return version;
        }),
      )
      .pipe(
        Effect.tap((version) =>
          revisesPlan ? closeStaleApproval(task, version, author, callerThreadId) : Effect.void,
        ),
      );

  const readSpec: ProjectTeamService["Service"]["readSpec"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const { task } = yield* specTaskFor(callerThreadId, input.taskId, "task_spec_read", "read");
      return yield* specResult(task, yield* latestSpec(task));
    }).pipe(orTeamError("Could not read the spec."));

  const writeSpec: ProjectTeamService["Service"]["writeSpec"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const { task, author } = yield* specTaskFor(callerThreadId, input.taskId, "task_spec_write");
      const problems = specLinkProblems(input.spec);
      if (problems.length > 0) {
        return yield* teamError(
          `The spec links to ids it does not have:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
          task.projectId,
        );
      }
      const version = yield* appendAgentSpec(
        callerThreadId,
        task,
        author,
        input.note,
        () => Effect.succeed(input.spec),
        input.baseVersion,
      );
      yield* router.publish(task.projectId);
      return yield* specResult(task, version);
    }).pipe(orTeamError("Could not write the spec."));

  const setTodo: ProjectTeamService["Service"]["setTodo"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const { task, author } = yield* specTaskFor(callerThreadId, input.taskId, "task_todo_set");
      const current = yield* latestSpec(task);
      const todo = current.spec.todos.find((candidate) => candidate.id === input.todoId);
      if (todo === undefined) {
        return yield* teamError(
          `The spec has no todo ${input.todoId}. Read it with task_spec_read.`,
          task.projectId,
        );
      }
      // Checking a todo that is already checked keeps the history quiet.
      if (todo.done === input.done) return yield* specResult(task, current);
      const version = yield* appendAgentSpec(
        callerThreadId,
        task,
        author,
        `${input.done ? "Checked" : "Unchecked"} "${clip(todo.text, 80)}"`,
        (latest) =>
          Effect.succeed({
            ...latest,
            todos: latest.todos.map((candidate) =>
              candidate.id === input.todoId ? { ...candidate, done: input.done } : candidate,
            ),
          }),
        undefined,
        false,
      );
      yield* router.publish(task.projectId);
      return yield* specResult(task, version);
    }).pipe(orTeamError("Could not update the todo."));

  const setEvidence: ProjectTeamService["Service"]["setEvidence"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const { task, author } = yield* specTaskFor(
        callerThreadId,
        input.taskId,
        "task_evidence_set",
      );
      const current = yield* latestSpec(task);
      const criterion = current.spec.criteria.find(
        (candidate) => candidate.id === input.criterionId,
      );
      if (criterion === undefined) {
        return yield* teamError(
          `The spec has no criterion ${input.criterionId}. Read it with task_spec_read.`,
          task.projectId,
        );
      }
      if (criterion.evidence === input.evidence) return yield* specResult(task, current);
      const version = yield* appendAgentSpec(
        callerThreadId,
        task,
        author,
        `Evidence for "${clip(criterion.text, 80)}"`,
        (latest) =>
          Effect.succeed({
            ...latest,
            criteria: latest.criteria.map((candidate) =>
              candidate.id === input.criterionId
                ? { ...candidate, evidence: input.evidence }
                : candidate,
            ),
          }),
        undefined,
        false,
      );
      yield* router.publish(task.projectId);
      return yield* specResult(task, version);
    }).pipe(orTeamError("Could not record the evidence."));

  /** The commit checked out in the lead's worktree; None when there is none or it can't be read. */
  const leadHead = (task: ProjectTask) =>
    Effect.gen(function* () {
      if (task.leadThreadId === null) return Option.none<string>();
      const shell = yield* threads
        .getThreadShell(task.leadThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.worktreePath === null) return Option.none<string>();
      if (shell.location === "cloud") yield* syncCloudLead(task.leadThreadId);
      return yield* worktreeHeads.read(shell.worktreePath);
    });

  /**
   * A cloud lead's Mac worktree is a mirror updated at turn end. Gates and
   * review steps run mid-turn, so they mirror the sandbox first.
   */
  const syncCloudLead = (leadThreadId: ThreadId) =>
    cloudLead.syncToMac(leadThreadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not mirror a cloud lead before reading its worktree", {
          leadThreadId,
          detail: error.message,
        }),
      ),
    );

  const shortSha = (sha: string) => sha.slice(0, 7);

  /** The review model a task's reviews must come from, or null when none is set. */
  const reviewModelOf = (task: ProjectTask) =>
    Effect.map(
      requireManager(task.projectId),
      (manager) =>
        resolveRoleModels(task.roleModels, manager.settings.roleModels).review?.target ?? null,
    );

  /**
   * Who may record a review: the task's lead, or a review session it started with
   * task_delegate(role: "review").
   */
  const reviewerOf = (callerThreadId: ThreadId) =>
    Effect.gen(function* () {
      const role = yield* roleOf(callerThreadId);
      if (role.type === "lead") {
        return { taskId: role.taskId, projectId: role.projectId, by: "lead" as const, model: null };
      }
      const session = yield* repository
        .findTaskSessionByThreadId(callerThreadId)
        .pipe(orTeamError("Could not read the review session."));
      if (Option.isNone(session) || session.value.role !== "reviewer") {
        return yield* teamError(
          'task_review_set is only for a task lead or the review session it started with task_delegate(role: "review").',
        );
      }
      const task = yield* repository
        .getTask(session.value.taskId)
        .pipe(orTeamError("Could not read the task."));
      if (Option.isNone(task))
        return yield* teamError(`Task ${session.value.taskId} was not found.`);
      const run = yield* repository
        .findModelRunByThreadId(callerThreadId)
        .pipe(orTeamError("Could not read the review session."));
      return {
        taskId: task.value.id,
        projectId: task.value.projectId,
        by: "reviewer" as const,
        model: Option.isSome(run) ? run.value.model : null,
      };
    });

  /** The reason a review does not let the task ship on HEAD, or null when it does. */
  const reviewGateProblem = (
    task: ProjectTask,
    reviewModel: ProjectTaskModelTarget | null,
  ): string | null => {
    const review = task.review;
    if (reviewModel === null || review === null || !review.clean) return null;
    const rerun = `Run task_delegate(role: "review") on HEAD; the review session records its result with task_review_set.`;
    if (review.by !== "reviewer") {
      return `#${task.number}'s clean review is your own, but it has a review model (${reviewModel.providerInstanceId} · ${reviewModel.model}). ${rerun}`;
    }
    // A review by a model the user has since replaced no longer counts.
    if (review.model !== undefined && review.model !== reviewModel.model) {
      return `#${task.number}'s clean review came from ${review.model}, but the review model is now ${reviewModel.model}. ${rerun}`;
    }
    return null;
  };

  const setReview: ProjectTeamService["Service"]["setReview"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const reviewer = yield* reviewerOf(callerThreadId);
      const task = yield* requireTask(reviewer.taskId, reviewer.projectId);
      if (input.taskId !== undefined && input.taskId !== task.id) {
        return yield* teamError(
          "task_review_set records a review of your own task only.",
          task.projectId,
        );
      }
      if (FinishedTaskCleanup.isFinishedStage(task.stage)) {
        return yield* teamError(
          `#${task.number} is ${task.stage}; there is nothing to review.`,
          task.projectId,
        );
      }
      const reviewModel = yield* reviewModelOf(task);
      if (reviewer.by === "lead" && input.clean && reviewModel !== null) {
        return yield* teamError(
          `#${task.number} has a review model (${reviewModel.providerInstanceId} · ${reviewModel.model}), so a clean review must come from it, not from you. Run task_delegate(role: "review") on HEAD; the review session records its result with task_review_set.`,
          task.projectId,
        );
      }
      const head = yield* leadHead(task);
      if (Option.isSome(head) && head.value !== input.head) {
        return yield* teamError(
          `HEAD is ${shortSha(head.value)}, not ${shortSha(input.head)}. Review the diff at HEAD and pass head = git rev-parse HEAD.`,
          task.projectId,
        );
      }
      const findings = input.findings.trim();
      if (!input.clean && findings.length === 0) {
        return yield* teamError(
          "A review that is not clean needs its findings, so the next round knows what to fix.",
          task.projectId,
        );
      }
      // Findings in review send the work back to Iterate; moving to running counts that round.
      const reopened = !input.clean && task.stage === "in_review";
      if (reopened) {
        const back = yield* setTask({ id: task.id, stage: "running" });
        yield* appendEvent(back, "stage_changed", `${task.stage} → ${back.stage}`, callerThreadId);
      }
      const recorded = yield* repository.recordTaskReview({
        id: task.id,
        review: {
          clean: input.clean,
          findings,
          head: input.head,
          reviewedAt: yield* nowIso,
          by: reviewer.by,
          ...(reviewer.model === null ? {} : { model: reviewer.model }),
        },
        startsIterateRound: !input.clean && task.stage === "running",
        now: yield* nowIso,
      });
      if (Option.isNone(recorded)) return yield* teamError(`Task ${task.id} was not found.`);
      const findingCount = findings.split("\n").filter((line) => line.trim().length > 0).length;
      const updated =
        input.clean || findingCount === 0
          ? recorded.value
          : Option.getOrElse(
              yield* repository
                .bumpTaskMetric({ id: task.id, metric: "reviewFindings", by: findingCount })
                .pipe(orTeamError("Could not count the findings.", task.projectId)),
              () => recorded.value,
            );
      const who =
        reviewer.by === "lead"
          ? "Self-review"
          : `Review by ${reviewer.model ?? "the review model"}`;
      yield* appendEvent(
        updated,
        "note",
        input.clean
          ? `${who} on ${shortSha(input.head)}: clean`
          : `${who} on ${shortSha(input.head)}: not clean, Iterate round ${updated.iterateRound}\n${clip(findings, 2_000)}`,
        callerThreadId,
      );
      yield* router.publish(task.projectId);
      return { task: updated };
    }).pipe(orTeamError("Could not record the review."));

  /**
   * Ship watches the pull request for the lead, so a failed check, comment or conflict wakes
   * it without being asked. A watch that can't start is logged; the lead can still watch.
   */
  const watchShippedPullRequest = (task: ProjectTask) =>
    Effect.gen(function* () {
      if (task.leadThreadId === null || task.prUrl === null) return;
      const parsed = parseChangeRequestUrl(task.prUrl);
      if (parsed === null) return;
      const key = normalizeThreadPullRequestKey(parsed);
      yield* threads.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`project-team:ship-watch:${yield* newId(task.id)}`),
        threadId: task.leadThreadId,
        host: key.host,
        repository: key.repository,
        number: key.number,
        watching: true,
        forTaskLead: true,
        link: { url: task.prUrl, source: "agent" },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not watch the shipped pull request", {
          taskId: task.id,
          prUrl: task.prUrl,
          cause,
        }),
      ),
    );

  /** Why the pull request can't be Ready yet, one fix per line; empty when it passes. */
  const readyGateProblems = (
    pr: PullRequestShipGate.PullRequestShipState,
    head: string,
    localChecks: string,
    unproven: ReadonlyArray<string>,
  ): ReadonlyArray<string> => {
    if (pr.state !== "open") return [`The pull request is ${pr.state}.`];
    const problems: Array<string> = [];
    if (pr.headSha !== null && pr.headSha !== head) {
      problems.push(
        `The pull request's head is ${shortSha(pr.headSha)}, not ${shortSha(head)}: push HEAD first.`,
      );
    }
    const failed = pr.checks.filter(isFailedCheck);
    if (failed.length > 0) {
      problems.push(
        `Checks failed: ${failed.map((check) => check.name).join(", ")}. Fix them and push.`,
      );
    }
    const pending = pr.checks.filter((check) => check.status === "pending");
    if (pending.length > 0) {
      problems.push(
        `Checks are still running: ${pending.map((check) => check.name).join(", ")}. End your turn; BusyBoy wakes you when they finish.`,
      );
    }
    if (pr.unresolvedThreads > 0) {
      problems.push(
        `${pr.unresolvedThreads} review ${pr.unresolvedThreads === 1 ? "thread is" : "threads are"} unresolved. Address each one and resolve it.`,
      );
    }
    if (pr.mergeability === "conflicting") {
      problems.push("The branch conflicts with its base. Rebase or merge the base and push.");
    } else if (pr.mergeability === "unknown") {
      problems.push(
        "The host is still checking whether the branch merges cleanly. Try again in a minute.",
      );
    }
    // Without checks, the lead's own evidence on this commit is the CI gate.
    if (pr.checks.length === 0) {
      if (unproven.length > 0) {
        problems.push(
          `The pull request has no checks, so every criterion needs evidence: ${unproven.join(", ")} has none. Record it with task_evidence_set.`,
        );
      }
      if (localChecks.trim().length === 0) {
        problems.push(
          "The pull request has no checks: run the tests, typecheck and lint on HEAD and pass the commands and their result as localChecks.",
        );
      }
    }
    return problems;
  };

  const markTaskReady: ProjectTeamService["Service"]["markTaskReady"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["lead"], "task_ready");
      const taskId = input.taskId ?? role.taskId;
      if (taskId !== role.taskId) {
        return yield* teamError("A task lead can only mark its own task ready.", role.projectId);
      }
      const task = yield* requireTask(taskId, role.projectId);
      if (task.stage !== "in_review" || task.prUrl === null) {
        return yield* teamError(
          `#${task.number} is ${task.stage}. Only an In Review task with a pull request can be Ready: open it and move to in_review first.`,
          task.projectId,
        );
      }
      const prUrl = task.prUrl;
      const worktreeHead = yield* leadHead(task);
      if (Option.isSome(worktreeHead) && worktreeHead.value !== input.head) {
        return yield* teamError(
          `HEAD is ${shortSha(worktreeHead.value)}, not ${shortSha(input.head)}. Pass head = git rev-parse HEAD.`,
          task.projectId,
        );
      }
      const review = task.review;
      if (review === null || !review.clean || review.head !== input.head) {
        return yield* teamError(
          `#${task.number} has no clean review of ${shortSha(input.head)}. Review the diff and record it with task_review_set first.`,
          task.projectId,
        );
      }
      const readyReviewProblem = reviewGateProblem(task, yield* reviewModelOf(task));
      if (readyReviewProblem !== null) {
        return yield* teamError(readyReviewProblem, task.projectId);
      }
      const pr = yield* shipGate.read({ projectId: task.projectId, url: prUrl });
      if (Option.isNone(pr)) {
        return yield* teamError(
          `Could not read ${prUrl} from the host. Check it yourself and try task_ready again.`,
          task.projectId,
        );
      }
      const unproven = unprovenCriteria((yield* latestSpec(task)).spec);
      const problems = readyGateProblems(pr.value, input.head, input.localChecks, unproven);
      if (problems.length > 0) {
        return yield* teamError(
          `#${task.number} is not Ready yet:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
          task.projectId,
        );
      }
      if (pr.value.isDraft) {
        yield* shipGate
          .markReady({ projectId: task.projectId, url: prUrl })
          .pipe(
            Effect.catch(() =>
              teamError(
                `Could not mark ${prUrl} ready for review. Run gh pr ready ${prUrl}, then call task_ready again.`,
                task.projectId,
              ),
            ),
          );
      }
      const gate = pr.value.checks.length === 0 ? "local" : "checks";
      const now = yield* nowIso;
      const recorded = yield* repository.setTaskReady({
        id: task.id,
        ready: {
          head: input.head,
          gate,
          localChecks: gate === "local" ? input.localChecks.trim() : "",
          readyAt: now,
        },
        now,
      });
      if (Option.isNone(recorded)) return yield* teamError(`Task ${task.id} was not found.`);
      yield* appendEvent(
        recorded.value,
        "note",
        gate === "checks"
          ? `Ready on ${shortSha(input.head)}: checks passed`
          : `Ready on ${shortSha(input.head)}: no checks, local evidence\n${clip(input.localChecks.trim(), 2_000)}`,
        callerThreadId,
      );
      yield* router.publish(task.projectId);
      return { task: recorded.value };
    }).pipe(orTeamError("Could not mark the task ready."));

  /** The user, or AFK while they were away, approved a plan for this task. */
  const hasApprovedPlan = (task: ProjectTask) =>
    repository
      .listAnsweredTaskAttentionItems({ taskId: task.id, kind: "approval" })
      .pipe(
        Effect.map((items) =>
          items.some(
            (item) => item.answer !== null && planApprovalOutcome(item.answer) !== "changes",
          ),
        ),
      );

  /** A subtask the parent's lead drafted with task_create, rather than one the PM or user added. */
  const isLeadDraft = (task: ProjectTask) =>
    repository
      .getSpecVersion({ taskId: task.id, version: 1 })
      .pipe(Effect.map((first) => Option.isSome(first) && first.value.author === "agent"));

  /**
   * The parent whose approved plan covers this subtask, or null. Approving a parent's
   * plan approves its whole breakdown: every subtask its lead drafted before that card,
   * and those the PM or the user filed under it. A subtask the lead drafts after the
   * approval waits for the next one.
   */
  const breakdownCoverage = (task: ProjectTask) =>
    Effect.gen(function* () {
      if (task.parentTaskId === null) return null;
      const parent = yield* repository.getTask(task.parentTaskId);
      if (Option.isNone(parent)) return null;
      const approvals = (yield* repository.listAnsweredTaskAttentionItems({
        taskId: parent.value.id,
        kind: "approval",
      })).filter((item) => item.answer !== null && planApprovalOutcome(item.answer) !== "changes");
      if (approvals.length === 0) return null;
      if (!(yield* isLeadDraft(task))) return parent.value;
      const created = isoMillis(task.createdAt);
      return approvals.some((item) => isoMillis(item.createdAt) >= created) ? parent.value : null;
    });

  /** A task's key, such as BU-7, in its own project's prefix. */
  const keyOf = (task: Pick<ProjectTask, "projectId" | "number">) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(task.projectId);
      const prefix = yield* taskKeyPrefixFor(
        task.projectId,
        Option.isSome(manager) ? manager.value.settings : DEFAULT_PROJECT_TEAM_SETTINGS,
      );
      return formatTaskKey(prefix, task.number);
    });

  /** What a covered subtask's plan summary says: its line in the parent's breakdown. */
  const coveredPlanSummary = (task: ProjectTask, parent: ProjectTask) =>
    Effect.gen(function* () {
      const parentSpec = yield* latestSpec(parent);
      const line = parentSpec.spec.todos.find((todo) => todo.subtaskId === task.id)?.text;
      return `Approved with ${yield* keyOf(parent)} ${parent.title}'s breakdown: ${clip(line ?? task.request, 1_500)}`;
    });

  /**
   * Each stage needs the previous phase's output: starting work needs an approved plan
   * (coming back from review, a blocker or Done is fine), and In Review needs a pull
   * request and evidence for every success criterion.
   */
  const checkStageGate = (
    task: ProjectTask,
    stage: ProjectTaskStage,
    prUrl: string | null | undefined,
  ) =>
    Effect.gen(function* () {
      if (
        stage === "running" &&
        PRE_WORK_STAGES.has(task.stage) &&
        !(yield* hasApprovedPlan(task)) &&
        (yield* breakdownCoverage(task)) === null
      ) {
        return yield* teamError(
          `#${task.number} has no approved plan yet, so it cannot start. Write the plan with task_spec_write and ask for approval with ask_user(kind: "approval"); approving it starts the task.`,
          task.projectId,
        );
      }
      if (stage === "in_review") {
        if ((prUrl === undefined ? task.prUrl : prUrl) === null) {
          return yield* teamError(
            `#${task.number} needs a pull request for In Review: pass prUrl. Without a remote, commit locally and move it to done instead.`,
            task.projectId,
          );
        }
        const unproven = unprovenCriteria((yield* latestSpec(task)).spec);
        if (unproven.length > 0) {
          return yield* teamError(
            `#${task.number} has success criteria without evidence: ${unproven.join(", ")}. Prove each one, then record it with task_evidence_set.`,
            task.projectId,
          );
        }
        // Ship starts from the lead's clean self-review of the commit being shipped.
        const review = task.review;
        if (task.leadThreadId !== null && review === null) {
          return yield* teamError(
            `#${task.number} has no self-review yet. Review your diff against the base branch, fix what you find, then record a clean review with task_review_set(clean, findings, head).`,
            task.projectId,
          );
        }
        if (review !== null && !review.clean) {
          return yield* teamError(
            `#${task.number}'s latest self-review is not clean. Fix its findings, review again, and record a clean review with task_review_set.`,
            task.projectId,
          );
        }
        const shipReviewProblem = reviewGateProblem(task, yield* reviewModelOf(task));
        if (shipReviewProblem !== null) {
          return yield* teamError(shipReviewProblem, task.projectId);
        }
        const head = yield* leadHead(task);
        if (review !== null && Option.isSome(head) && head.value !== review.head) {
          return yield* teamError(
            `#${task.number}'s clean self-review covers ${shortSha(review.head)}, but HEAD is now ${shortSha(head.value)}. Review the new commits and record it again with task_review_set.`,
            task.projectId,
          );
        }
        // The pull request follows the user's PR rules; one that can't be read is let through.
        const url = prUrl ?? task.prUrl;
        const text = url === null ? Option.none() : yield* pullRequestText.read(url);
        const problems = Option.isSome(text) ? pullRequestFormatProblems(text.value) : [];
        if (problems.length > 0) {
          return yield* teamError(
            `The pull request does not follow the PR rules yet. Fix it with gh pr edit, then move to In Review again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
            task.projectId,
          );
        }
      }
    });

  const updateTask = (
    callerThreadId: ThreadId,
    input: ProjectTeamTaskUpdateInput,
    answeringItem?: ProjectAttentionItem,
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "task_update");
      const taskId = input.taskId ?? (role.type === "lead" ? role.taskId : undefined);
      if (taskId === undefined) return yield* teamError("task_update needs a taskId.");
      if (role.type === "lead" && taskId !== role.taskId) {
        return yield* teamError("A task lead can only update its own task.", role.projectId);
      }
      const task = yield* requireTask(taskId, role.projectId);
      // An epic has no lead; its stage follows its subtasks, except that it can be cancelled.
      if (
        role.type === "director" &&
        input.stage !== undefined &&
        input.stage !== "cancelled" &&
        input.stage !== task.stage
      ) {
        return yield* teamError(
          "An epic's stage follows its subtasks; you can only cancel it.",
          role.projectId,
        );
      }
      const structural =
        input.title !== undefined ||
        input.waitsOn !== undefined ||
        input.parentTaskId !== undefined;
      if (role.type === "lead" && structural) {
        return yield* teamError(
          "Only the PM can change a task's title, waitsOn or parent.",
          role.projectId,
        );
      }
      if (input.stage !== undefined && input.stage !== task.stage) {
        yield* checkStageGate(task, input.stage, input.prUrl);
      }
      const dependencies =
        input.waitsOn === undefined
          ? undefined
          : yield* checkWaitsOn(task.id, input.waitsOn, role.projectId);
      const parent =
        input.parentTaskId === undefined || input.parentTaskId === null
          ? input.parentTaskId
          : yield* checkParent(task.id, input.parentTaskId, role.projectId);
      if (input.size !== undefined && input.size !== task.metrics.size) {
        yield* repository
          .setTaskSize({ id: task.id, size: input.size, now: yield* nowIso })
          .pipe(orTeamError("Could not record the task size.", role.projectId));
        yield* appendEvent(task, "note", `Size: ${input.size}`, callerThreadId);
      }
      const updated = yield* setTask(
        {
          id: task.id,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(dependencies === undefined ? {} : { waitsOn: dependencies.map((dep) => dep.id) }),
          ...(parent === undefined ? {} : { parentTaskId: parent === null ? null : parent.id }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
          ...(input.planSummary === undefined ? {} : { planSummary: input.planSummary }),
          ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
          ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
        },
        answeringItem,
      );
      const stageChanged = updated.stage !== task.stage;
      if (stageChanged) {
        yield* appendEvent(
          updated,
          "stage_changed",
          `${task.stage} → ${updated.stage}`,
          callerThreadId,
        );
      }
      if (input.planSummary !== undefined) {
        yield* appendEvent(updated, "summary", `Plan: ${input.planSummary}`, callerThreadId);
      }
      if (input.resultSummary !== undefined) {
        yield* appendEvent(updated, "summary", `Result: ${input.resultSummary}`, callerThreadId);
      }
      if (input.prUrl !== undefined && input.prUrl !== task.prUrl) {
        yield* appendEvent(updated, "note", `Pull request: ${input.prUrl}`, callerThreadId);
      }
      if (input.note !== undefined) {
        yield* appendEvent(updated, "note", input.note, callerThreadId);
      }
      if (input.title !== undefined && input.title !== task.title) {
        yield* appendEvent(updated, "note", `Renamed from "${task.title}"`, callerThreadId);
      }
      if (dependencies !== undefined) {
        const list = dependencies.map((dep) => `#${dep.number} ${dep.title}`).join(", ");
        const body = list.length === 0 ? "Waits on nothing" : `Waits on ${list}`;
        yield* appendEvent(updated, "note", body, callerThreadId);
      }
      if (parent !== undefined) {
        const body = parent === null ? "No parent" : `Part of #${parent.number} ${parent.title}`;
        yield* appendEvent(updated, "note", body, callerThreadId);
      }
      if (
        (stageChanged && updated.stage === "done") ||
        (task.prUrl === null && updated.prUrl !== null)
      ) {
        yield* sitreps.noteMilestone(role.projectId);
      }
      if (stageChanged) yield* noteIdleMilestone(role.projectId, task.stage);
      if (stageChanged && isDependencyCleared(updated.stage) && updated.parentTaskId !== null) {
        const parent = yield* repository.getTask(updated.parentTaskId);
        if (Option.isSome(parent)) {
          const state = updated.stage === "done" ? "done" : "in review";
          yield* wakeReadySubtasks(
            parent.value,
            `${yield* keyOf(updated)} ${updated.title} is ${state}.`,
          );
        }
      }
      if (stageChanged && FinishedTaskCleanup.isFinishedStage(updated.stage)) {
        // A PM cancel stops the lead now; otherwise the lead's turn ends first.
        yield* finishedTasks.archiveLead(updated, {
          stopLead: role.type === "pm" && updated.stage === "cancelled",
        });
      } else if (stageChanged && FinishedTaskCleanup.isFinishedStage(task.stage)) {
        // Reopened, like moving a Linear issue out of Done: the lead and worktree return.
        yield* finishedTasks.reviveLead(updated);
      }
      if (stageChanged && updated.stage === "done") yield* finishParentIfDone(updated);
      if (updated.stage === "in_review" && (stageChanged || updated.prUrl !== task.prUrl)) {
        yield* watchShippedPullRequest(updated);
      }
      yield* router.publish(role.projectId);
      return { task: updated };
    }).pipe(orTeamError("Could not update the task."));

  /** What the user recently typed in the PM chat; a read failure leaves it empty. */
  const recentUserWords = (managerThreadId: ThreadId) =>
    threads.getThreadRecords(managerThreadId, ["messages"], { messageRoles: ["user"] }).pipe(
      Effect.map(({ messages }) =>
        messages
          .filter(
            (message) =>
              message.createdBy === "user" && USER_TYPED_SOURCES.has(message.creationSource),
          )
          .slice(-USER_LANGUAGE_SAMPLE)
          .map((message) => message.text),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const lastLeadMessage = (leadThreadId: ThreadId) =>
    threads.getThreadRecords(leadThreadId, ["messages"], { messageRoles: ["assistant"] }).pipe(
      Effect.map(({ messages }) => {
        const text =
          messages
            .filter((message) => message.text.trim().length > 0)
            .toSorted(
              (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
            )
            .at(-1)
            ?.text.trim() ?? "";
        if (text.length === 0) return "the task lead has not said anything yet.";
        return text.length > LEAD_MESSAGE_SUMMARY_MAX_CHARS
          ? `${text.slice(0, LEAD_MESSAGE_SUMMARY_MAX_CHARS)}…`
          : text;
      }),
      Effect.orElseSucceed(() => "the task lead's last message could not be read."),
    );

  /** True when the lead logged anything (a note, spec version, stage) since the PM's last nudge. */
  const leadProgressedSinceNudge = (task: ProjectTask) =>
    Effect.gen(function* () {
      if (task.leadThreadId === null) return false;
      const events = yield* repository.listTaskEvents({ taskId: task.id, limit: 50 });
      const lastNudge = events.findLast((event) => event.kind === "nudge");
      if (lastNudge === undefined) return false;
      const since = isoMillis(lastNudge.createdAt);
      return events.some(
        (event) =>
          event.actorThreadId === task.leadThreadId &&
          event.kind !== "outcome" &&
          isoMillis(event.createdAt) > since,
      );
    });

  /**
   * The PM adds the user's scope to a task. It is not a stall nudge, so it never counts
   * toward escalation, and an open approval card closes: the plan it shows is now short
   * of the scope, so the lead folds it in and asks again.
   */
  const addScope = (
    callerThreadId: ThreadId,
    task: ProjectTask,
    leadThreadId: ThreadId,
    note: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (note === undefined) {
        return yield* teamError(
          "A scope nudge needs a note with the scope to add.",
          task.projectId,
        );
      }
      const open = (yield* repository.listOpenAttentionItems({
        projectId: task.projectId,
        taskId: task.id,
      })).filter((item) => item.kind === "approval");
      const now = yield* nowIso;
      for (const item of open) {
        yield* repository.supersedeAttentionItem({ id: item.id, supersededAt: now });
      }
      const current =
        open.length > 0 && task.stage === "awaiting_approval"
          ? yield* moveTaskStage(task, "planning", callerThreadId)
          : task;
      const key = `project-team:scope:${yield* newId(task.id)}`;
      yield* threads.sendToThread({
        projectId: task.projectId,
        commandId: CommandId.make(key),
        threadId: leadThreadId,
        messageId: MessageId.make(key),
        senderThreadId: callerThreadId,
        text: [
          `[PM scope note] The user added scope: ${note}`,
          open.length > 0
            ? "Your approval card closed because the plan it showed lacks this. Fold it into the spec with task_spec_write and ask for approval again."
            : PRE_APPROVAL_STAGES.has(current.stage)
              ? "Fold it into your plan before you ask for approval."
              : "Fold it into the spec and the work. If it changes the goal or the success criteria materially, ask for approval again.",
        ].join(" "),
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      });
      yield* appendEvent(
        current,
        "note",
        `Scope added by the PM${open.length > 0 ? "; the open approval card closed" : ""}: ${note}`,
        callerThreadId,
      );
      yield* router.publish(task.projectId);
      return { status: "sent", task: current, attentionItem: null } as const;
    });

  const nudgeTask: ProjectTeamService["Service"]["nudgeTask"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm"], "task_nudge");
      const task = yield* requireTask(input.taskId, role.projectId);
      if (task.leadThreadId === null) {
        return yield* teamError(`#${task.number} has no task lead yet.`, role.projectId);
      }
      if (task.stage === "done" || task.stage === "cancelled") {
        return yield* teamError(`#${task.number} is already ${task.stage}.`, role.projectId);
      }
      if (input.scope === true) {
        return yield* addScope(callerThreadId, task, task.leadThreadId, input.note);
      }
      // Escalate only a lead that did nothing since the last nudge; one that made
      // progress starts its count again.
      const counted =
        task.nudgeCount >= MAX_TASK_NUDGES && (yield* leadProgressedSinceNudge(task))
          ? yield* setTask({ id: task.id, nudgeCount: 0 })
          : task;
      if (counted.nudgeCount >= MAX_TASK_NUDGES) {
        const open = yield* repository.listOpenAttentionItems({
          projectId: role.projectId,
          taskId: task.id,
        });
        const existing = open.find((item) => item.kind === "blocker");
        if (existing !== undefined) {
          return { status: "escalated", task, attentionItem: existing } as const;
        }
        const item = yield* router.ask({
          task,
          kind: "blocker",
          question: `#${task.number} ${task.title} made no progress after ${MAX_TASK_NUDGES} nudges. Last message: ${yield* lastLeadMessage(task.leadThreadId)}`,
          options: [],
          askerThreadId: task.leadThreadId,
        });
        yield* appendEvent(task, "note", "Nudge limit reached; raised a blocker.", callerThreadId);
        yield* router.publish(role.projectId);
        return { status: "escalated", task, attentionItem: item } as const;
      }
      const key = `project-team:nudge:${yield* newId(task.id)}`;
      yield* threads.sendToThread({
        projectId: role.projectId,
        commandId: CommandId.make(key),
        threadId: task.leadThreadId,
        messageId: MessageId.make(key),
        senderThreadId: callerThreadId,
        text: [
          `[PM nudge] Continue. Current stage: ${task.stage}. Next step: ${nextStepHint(task.stage)}`,
          ...(input.note === undefined ? [] : [input.note]),
        ].join(" "),
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      });
      const nudged = yield* setTask({ id: task.id, nudgeCount: counted.nudgeCount + 1 });
      yield* appendEvent(nudged, "nudge", input.note ?? "Continue.", callerThreadId);
      yield* router.publish(role.projectId);
      return { status: "sent", task: nudged, attentionItem: null } as const;
    }).pipe(orTeamError("Could not nudge the task."));

  const listTasks: ProjectTeamService["Service"]["listTasks"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "task_list");
      const tasks = yield* repository.listTasks({
        projectId: role.projectId,
        ...(input.stages === undefined ? {} : { stages: input.stages }),
      });
      const limited = input.limit === undefined ? tasks : tasks.slice(0, input.limit);
      const brief = yield* liveTaskSignals(
        limited,
        yield* repository.listOpenAttentionItems({ projectId: role.projectId }),
      );
      return { tasks: limited.map(brief) };
    }).pipe(orTeamError("Could not list tasks."));

  const readTask: ProjectTeamService["Service"]["readTask"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "task_read");
      // The Director reads tasks in every project.
      const task =
        role.type === "director"
          ? yield* requireAnyTask(input.taskId, role.projectId)
          : yield* requireTask(input.taskId, role.projectId);
      const events = yield* repository.listTaskEvents({
        taskId: task.id,
        limit: input.eventLimit ?? DEFAULT_TASK_EVENT_LIMIT,
      });
      const openAttention = yield* repository.listOpenAttentionItems({
        projectId: task.projectId,
        taskId: task.id,
      });
      return { task, events, openAttention };
    }).pipe(orTeamError("Could not read the task."));

  const searchTasks: ProjectTeamService["Service"]["searchTasks"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "task_search");
      const limit = input.limit ?? DEFAULT_TASK_SEARCH_LIMIT;
      // The Director searches every project with a manager, its own epics included.
      const projectIds =
        role.type === "director"
          ? (yield* repository.listManagers()).map((manager) => manager.projectId)
          : [role.projectId];
      const found = yield* Effect.forEach(projectIds, (projectId) =>
        repository.searchTasks({ projectId, query: input.query, limit }),
      );
      const tasks = found
        .flat()
        .toSorted((a, b) => isoMillis(b.updatedAt) - isoMillis(a.updatedAt))
        .slice(0, limit);
      return { tasks };
    }).pipe(orTeamError("Could not search tasks."));

  const teamStatus: ProjectTeamService["Service"]["teamStatus"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "team_status");
      const projectId = role.projectId;
      const manager = yield* requireManager(projectId);
      const since: IsoDateTime | null =
        input.since ??
        [manager.lastSitrepAt, manager.lastUserMessageAt]
          .filter((value): value is IsoDateTime => value !== null)
          .toSorted((a, b) => isoMillis(b) - isoMillis(a))[0] ??
        null;
      const sinceMs = since === null ? Number.NEGATIVE_INFINITY : isoMillis(since);
      const tasks = yield* repository.listTasks({ projectId });
      const openAttention = yield* repository.listOpenAttentionItems({ projectId });
      const brief = yield* liveTaskSignals(tasks, openAttention);
      const briefs = (stage: ProjectTaskStage) =>
        tasks.filter((task) => task.stage === stage).map(brief);
      const changedSince = (task: ProjectTask) => isoMillis(task.stageChangedAt) > sinceMs;
      const newAttention: ReadonlyArray<ProjectAttentionItem> =
        since === null
          ? openAttention
          : yield* repository.listAttentionItemsSince({ projectId, since });
      const journal = buildJournal({
        tasks,
        endings: yield* repository.listRecentTaskEndings({ projectId, limit: JOURNAL_LIMIT }),
        answered: yield* repository.listRecentlyAnsweredAttentionItems({
          projectId,
          limit: JOURNAL_LIMIT,
        }),
        sitreps: yield* repository.listRecentPostedSitreps({ projectId, limit: JOURNAL_LIMIT }),
      });
      const memoryTopics = (yield* repository.listMemory(projectId)).map((entry) => entry.topic);
      if (role.type !== "lead") yield* sitreps.noteStatusRead(projectId);
      const otherThreads = yield* readOtherThreads({
        threads,
        repository,
        projectId,
        managerThreadId: manager.threadId,
        withRequestText: true,
      });
      return {
        projectId,
        taskKeyPrefix: yield* taskKeyPrefixFor(projectId, manager.settings),
        tasks: {
          inbox: briefs("inbox"),
          planning: briefs("planning"),
          awaiting_approval: briefs("awaiting_approval"),
          running: briefs("running"),
          in_review: briefs("in_review"),
          done: briefs("done"),
          blocked: briefs("blocked"),
          cancelled: briefs("cancelled"),
        },
        statusCounts: countTaskStatuses(tasks.map(brief)),
        stalled: tasks
          .filter((task) => task.lastOutcome === "stalled" && LIVE_TASK_STAGES.has(task.stage))
          .map(brief),
        openAttention,
        settings: manager.settings,
        changes: {
          since,
          done: tasks.filter((task) => task.stage === "done" && changedSince(task)).map(brief),
          prOpened: tasks
            .filter(
              (task) => task.stage === "in_review" && task.prUrl !== null && changedSince(task),
            )
            .map(brief),
          newAttention,
          blocked: tasks
            .filter((task) => task.stage === "blocked" && changedSince(task))
            .map(brief),
          otherThreads: otherThreads.filter((thread) => isoMillis(thread.lastUpdateAt) > sinceMs),
        },
        otherThreads,
        journal,
        memoryTopics,
        ...(role.type === "director"
          ? { workspace: yield* workspaceView(projectId, tasks, openAttention) }
          : {}),
      } satisfies ProjectTeamStatus;
    }).pipe(orTeamError("Could not read the team status."));

  /**
   * The Director's view of the workspace: each project's counts, open tasks and
   * questions, and its PM's summary; then each open epic with its subtasks; then the
   * goals and how every task lines up with them.
   */
  const workspaceView = (
    directorProjectId: ProjectId,
    epics: ReadonlyArray<ProjectTask>,
    epicAttention: ReadonlyArray<ProjectAttentionItem>,
  ) =>
    Effect.gen(function* () {
      const managers = (yield* repository.listManagers()).filter(
        (manager) => manager.kind === "pm",
      );
      const briefById = new Map<string, ProjectTaskBrief>();
      const prefixByProject = new Map<string, string>();
      const alignable: Array<AlignableTask> = [];
      const projectsView: Array<ProjectTeamWorkspaceProject> = [];
      for (const manager of managers) {
        const project = yield* projects.get(manager.projectId);
        if (Option.isNone(project) || project.value.deletedAt !== null) continue;
        const tasks = yield* repository.listTasks({ projectId: manager.projectId });
        const openAttention = yield* repository.listOpenAttentionItems({
          projectId: manager.projectId,
        });
        const brief = yield* liveTaskSignals(tasks, openAttention);
        const briefs = tasks.map(brief);
        for (const item of briefs) briefById.set(item.id, item);
        alignable.push(...tasks.map((task) => toAlignableTask(task, openAttention)));
        const prefix = yield* taskKeyPrefixFor(manager.projectId, manager.settings);
        prefixByProject.set(manager.projectId, prefix);
        const summary = (yield* repository.listMemory(manager.projectId)).find(
          (entry) => entry.topic === PROJECT_SUMMARY_TOPIC,
        );
        projectsView.push({
          projectId: manager.projectId,
          title: project.value.title,
          pmName: resolvePersona(manager.projectId, manager.settings).name,
          taskKeyPrefix: prefix,
          statusCounts: countTaskStatuses(briefs),
          openTasks: briefs.filter((item) => item.stage !== "done" && item.stage !== "cancelled"),
          openAttention,
          summary: summary?.content ?? null,
        });
      }
      const epicsView: Array<ProjectTeamEpic> = [];
      for (const epic of epics) {
        if (epic.stage === "done" || epic.stage === "cancelled") continue;
        const children = yield* repository.listChildTasks(epic.id);
        epicsView.push({
          task: toTaskBrief(epic),
          children: children.map((child) => ({
            id: child.id,
            projectId: child.projectId,
            key: formatTaskKey(prefixByProject.get(child.projectId) ?? "T", child.number),
            title: child.title,
            status: (briefById.get(child.id) ?? toTaskBrief(child)).status,
          })),
        });
      }
      alignable.push(...epics.map((epic) => toAlignableTask(epic, epicAttention)));
      const goals = yield* repository.listWorkspaceGoals();
      return {
        projects: projectsView,
        epics: epicsView,
        goals,
        alignment: alignWorkspaceGoals({
          goals,
          tasks: alignable,
          projectIds: [directorProjectId, ...projectsView.map((project) => project.projectId)],
        }),
      } satisfies ProjectTeamWorkspace;
    });

  const applySettings = (
    projectId: ProjectId,
    patch: {
      readonly maxConcurrentTasks?: number | undefined;
      readonly sitrepIntervalMinutes?: number | undefined;
      readonly sitrepNotify?: boolean | undefined;
      readonly quietHours?: ProjectTeamSettings["quietHours"] | null | undefined;
      readonly persona?: PersonaPatch | undefined;
      readonly enabled?: boolean | undefined;
      readonly taskKeyPrefix?: string | undefined;
      readonly roleModels?: ProjectTaskRoleModelsPatch | undefined;
      readonly mergeOwner?: ProjectMergeOwner | undefined;
      /** User-only; updateSettingsAsManager never passes it. */
      readonly afk?: { readonly hours: number | null } | null | undefined;
    },
    actorThreadId: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      yield* reconcileTaskKeyPrefixes;
      if (patch.taskKeyPrefix !== undefined) {
        const collisions = (yield* repository.listManagers()).filter(
          (candidate) =>
            candidate.projectId !== projectId &&
            candidate.settings.taskKeyPrefix === patch.taskKeyPrefix,
        );
        for (const collision of collisions) {
          const project = yield* projects.get(collision.projectId);
          if (Option.isNone(project) || project.value.deletedAt !== null) continue;
          const title = project.value.title;
          return yield* teamError(
            `태스크 접두어 ${patch.taskKeyPrefix}는 ‘${title}’ 프로젝트에서 사용 중입니다. 다른 접두어를 지정해 주세요.`,
            projectId,
          );
        }
      }
      const { persona: personaPatch, ...plain } = patch;
      if (
        Object.values(plain).every((value) => value === undefined) &&
        !hasPersonaChange(personaPatch)
      ) {
        return yield* teamError("The settings update has no fields.", projectId);
      }
      const { manager, settings, now, previousPersona, persona, afkFlipped } =
        yield* sitreps.withSettingsLock(
          projectId,
          Effect.gen(function* () {
            const manager = yield* requireManager(projectId);
            const now = yield* nowIso;
            const previousPersona = resolvePersona(projectId, manager.settings);
            const persona = hasPersonaChange(personaPatch)
              ? mergePersona(previousPersona, personaPatch)
              : previousPersona;
            // The legacy "Auto-approve plans" key is read as AFK and never written back.
            const {
              quietHours: _previousQuietHours,
              afk: _previousAfk,
              autoApprovePlans: _legacyAutoApprove,
              ...current
            } = manager.settings;
            // Repeated writes preserve the AFK window and only real transitions wake the team.
            const previous = afkSetting(manager.settings);
            const wasActive = afkActive(previous, Date.parse(now));
            let afk = previous;
            if (patch.afk === null) {
              afk = undefined;
            } else if (patch.afk !== undefined) {
              const until =
                patch.afk.hours === null
                  ? null
                  : DateTime.formatIso(
                      DateTime.add(DateTime.makeUnsafe(now), { hours: patch.afk.hours }),
                    );
              afk =
                wasActive && previous !== undefined
                  ? previous.until === until
                    ? previous
                    : { since: previous.since, until }
                  : { since: now, until };
            }
            const isActive = afkActive(afk, Date.parse(now));
            const afkFlipped = patch.afk !== undefined && wasActive !== isActive;
            const quietHours =
              patch.quietHours === undefined
                ? manager.settings.quietHours
                : (patch.quietHours ?? undefined);
            const { roleModels: previousRoleModels, ...currentRest } = current;
            const roleModels =
              patch.roleModels === undefined
                ? previousRoleModels
                : applyRoleModelsPatch(previousRoleModels ?? {}, patch.roleModels);
            const settings: ProjectTeamSettings = {
              ...currentRest,
              ...(roleModels === undefined || Object.keys(roleModels).length === 0
                ? {}
                : { roleModels }),
              ...(patch.maxConcurrentTasks === undefined
                ? {}
                : { maxConcurrentTasks: patch.maxConcurrentTasks }),
              ...(patch.sitrepIntervalMinutes === undefined
                ? {}
                : { sitrepIntervalMinutes: patch.sitrepIntervalMinutes }),
              ...(patch.sitrepNotify === undefined ? {} : { sitrepNotify: patch.sitrepNotify }),
              ...(quietHours === undefined ? {} : { quietHours }),
              persona,
              ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
              ...(patch.taskKeyPrefix === undefined
                ? {}
                : {
                    taskKeyPrefix: patch.taskKeyPrefix,
                    taskKeyAliases: [
                      ...new Set([
                        ...(manager.settings.taskKeyAliases ?? []),
                        ...(manager.settings.taskKeyPrefix === undefined ||
                        manager.settings.taskKeyPrefix === patch.taskKeyPrefix
                          ? []
                          : [manager.settings.taskKeyPrefix]),
                      ]),
                    ],
                  }),
              ...(patch.mergeOwner === undefined ? {} : { mergeOwner: patch.mergeOwner }),
              ...(afk === undefined ? {} : { afk }),
              // Only setting the interval by hand stops it adapting, for good; other fields
              // keep the pin as is.
              ...(patch.sitrepIntervalMinutes === undefined ? {} : { intervalPinnedAt: now }),
            };
            yield* repository.updateManagerSettings({ projectId, settings, now });
            return { manager, settings, now, previousPersona, persona, afkFlipped };
          }),
        );
      if (persona.name !== previousPersona.name) {
        yield* renameManagerThread(manager.threadId, persona.name);
      }
      // The system prompt only refreshes when the PM's session reopens, so a user's change
      // reaches the live PM as a message. A PM that changed itself already knows.
      const mergeOwnerNews =
        mergeOwnerOf(settings) === mergeOwnerOf(manager.settings)
          ? null
          : mergeOwnerChangeText(mergeOwnerOf(settings));
      const personaNews =
        actorThreadId === null
          ? [personaChangeText(previousPersona, persona), mergeOwnerNews]
              .filter((line): line is string => line !== null)
              .join("\n") || null
          : null;
      if (personaNews !== null && settings.enabled) {
        const key = `project-team:persona:${projectId}:${now}`;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId: manager.threadId,
          messageId: MessageId.make(key),
          text: personaNews,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "system",
          creationSource: "server",
        });
      }
      if (settings.sitrepIntervalMinutes !== manager.settings.sitrepIntervalMinutes) {
        yield* repository.appendTaskEvent({
          id: ProjectTaskEventId.make(yield* newId("project-event")),
          projectId,
          taskId: null,
          kind: "preference_changed",
          body: SitrepScheduler.preferenceChangedBody(settings.sitrepIntervalMinutes, "you set it"),
          actorThreadId,
          createdAt: now,
        });
      }
      if (afkFlipped) {
        yield* repository.appendTaskEvent({
          id: ProjectTaskEventId.make(yield* newId("project-event")),
          projectId,
          taskId: null,
          kind: "preference_changed",
          body: afkEventBody(settings.afk),
          actorThreadId,
          createdAt: now,
        });
        yield* announceAfk(projectId, manager.threadId, settings.afk, now);
        // Questions that already waited past the grace period are answered now.
        if (settings.afk !== undefined) yield* afkSweepProject({ ...manager, settings });
      }
      yield* router.publish(projectId);
      return { projectId, settings };
    }).pipe(
      (effect) => taskKeyLocks.withLock("prefixes", effect),
      orTeamError("Could not update the team settings.", projectId),
    );

  const updateSettingsAsManager: ProjectTeamService["Service"]["updateSettingsAsManager"] = (
    callerThreadId,
    input,
  ) =>
    requireRole(callerThreadId, ["pm", "director"], "team_settings_update").pipe(
      Effect.flatMap((role) =>
        applySettings(
          role.projectId,
          {
            maxConcurrentTasks: input.maxConcurrentTasks,
            sitrepIntervalMinutes: input.sitrepIntervalMinutes,
            sitrepNotify: input.sitrepNotify,
            quietHours: input.quietHours,
            // The PM cannot turn itself off; only the user can, through the client.
            persona: {
              name: input.name,
              avatar:
                input.avatarEmoji === undefined
                  ? undefined
                  : { kind: "emoji", emoji: input.avatarEmoji },
              voice: input.voice,
            },
            taskKeyPrefix: input.taskKeyPrefix,
            roleModels: input.roleModels,
            mergeOwner: input.mergeOwner,
          },
          callerThreadId,
        ),
      ),
    );

  const updateSettings: ProjectTeamService["Service"]["updateSettings"] = ({
    projectId,
    ...patch
  }) => applySettings(projectId, patch, null);

  /** Subtasks a lead drafted under this task that have not started: its breakdown. */
  const openDrafts = (task: ProjectTask) =>
    Effect.gen(function* () {
      const children = (yield* repository.listChildTasks(task.id)).filter(
        (child) => child.stage === "inbox",
      );
      return yield* Effect.filter(children, isLeadDraft);
    });

  /**
   * A plan approval reviews the latest spec version. It replaces the task's older open
   * approval card and shows the task as Waiting for approval until the user answers.
   */
  const askPlanApproval = (
    callerThreadId: ThreadId,
    task: ProjectTask,
    input: ProjectTeamAskUserInput,
  ) =>
    Effect.gen(function* () {
      if (FinishedTaskCleanup.isFinishedStage(task.stage)) {
        return yield* teamError(`#${task.number} is finished; it needs no plan approval.`);
      }
      const coveredBy = yield* breakdownCoverage(task);
      if (coveredBy !== null) {
        const parentKey = yield* keyOf(coveredBy);
        return yield* teamError(
          `#${task.number} needs no approval card: the user approved it with ${parentKey} ${coveredBy.title}'s breakdown. Write your detailed plan with task_spec_write, then call task_update(stage: "running", planSummary). If its goal or verification must change materially, don't ask here: record it with task_update(note: "Breakdown change: ...") and end your turn, so ${parentKey}'s breakdown is re-approved once for all its subtasks.`,
          task.projectId,
        );
      }
      const spec = yield* latestSpec(task);
      const unlinked = (yield* openDrafts(task)).filter(
        (draft) => !spec.spec.todos.some((todo) => todo.subtaskId === draft.id),
      );
      const gaps = [
        ...planReadinessGaps(spec.spec),
        ...unlinked.map(
          (draft) =>
            `Subtask #${draft.number} "${draft.title}" has no todo: add one with subtaskId "${draft.id}" so the card shows it in the breakdown.`,
        ),
      ];
      if (gaps.length > 0) {
        return yield* teamError(
          `The plan in spec v${spec.version} is not ready for review. Fix these with task_spec_write, then ask again:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`,
          task.projectId,
        );
      }
      const now = yield* nowIso;
      yield* repository.supersedeOpenAttentionItems({
        taskId: task.id,
        kind: "approval",
        supersededAt: now,
      });
      const item = yield* router.ask({
        task,
        kind: "approval",
        question: input.question,
        context: input.context,
        // One way to approve: approving always starts the work.
        options: [PLAN_APPROVAL_START],
        askerThreadId: callerThreadId,
        specVersion: spec.version,
        // The card opens with the plan's summary; its todos come from the pinned version.
        summary: spec.spec.summary,
      });
      yield* moveTaskStage(task, "awaiting_approval", callerThreadId);
      yield* appendEvent(
        task,
        "note",
        `Asked the user to approve the plan (spec v${spec.version}).`,
        callerThreadId,
      );
      // While the user is AFK, the AFK sweep approves it after the grace period.
      return { item };
    });

  /** Moves a task to a new stage and logs it; no-op when it is already there. */
  const moveTaskStage = (
    task: ProjectTask,
    stage: ProjectTaskStage,
    actorThreadId: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      if (task.stage === stage) return task;
      const updated = yield* setTask({ id: task.id, stage });
      yield* appendEvent(
        updated,
        "stage_changed",
        `${task.stage} → ${updated.stage}`,
        actorThreadId,
      );
      yield* router.publish(task.projectId);
      return updated;
    });

  /**
   * After the user answers a plan approval, the task leaves Waiting for approval:
   * start → running, approve only → inbox, feedback → planning.
   */
  const afterPlanApprovalAnswer = (item: ProjectAttentionItem, actorThreadId: ThreadId | null) =>
    Effect.gen(function* () {
      if (item.kind !== "approval" || item.answer === null || item.taskId === null) return;
      const task = yield* requireTask(item.taskId, item.projectId);
      if (task.stage !== "awaiting_approval") return;
      const outcome = planApprovalOutcome(item.answer);
      yield* moveTaskStage(
        task,
        outcome === "start" ? "running" : outcome === "approve_only" ? "inbox" : "planning",
        actorThreadId,
      );
      if (outcome !== "changes") {
        yield* wakeReadySubtasks(
          task,
          `${yield* keyOf(task)} ${task.title}'s plan was approved with its breakdown.`,
        );
      }
    });

  const askUser: ProjectTeamService["Service"]["askUser"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["lead", "director", "pm"], "ask_user");
      if (role.type === "director") return yield* askAsDirector(callerThreadId, role, input);
      if (role.type === "pm") return yield* askAsManager(callerThreadId, role, input);
      const task = yield* requireTask(role.taskId, role.projectId);
      if (input.kind === "approval") return yield* askPlanApproval(callerThreadId, task, input);
      const item = yield* router.ask({
        task,
        kind: input.kind,
        question: input.question,
        context: input.context,
        options: input.options ?? [],
        askerThreadId: callerThreadId,
      });
      // The question shows on the task's page and above the PM composer; the PM is not woken.
      yield* appendEvent(task, "note", `Asked the user (${input.kind}).`, callerThreadId);
      return { item };
    }).pipe(orTeamError("Could not ask the user."));

  /**
   * The PM's own blocker or decision card: about the project, not a task. It shows in
   * the PM chat and the Director's waiting list, and the answer comes back to the PM.
   */
  const askAsManager = (
    callerThreadId: ThreadId,
    role: Extract<ProjectTeamRole, { readonly type: "pm" }>,
    input: ProjectTeamAskUserInput,
  ) =>
    Effect.gen(function* () {
      if (input.kind === "approval") {
        return yield* teamError(
          "A PM asks the user only for blockers and decisions (kind: blocker or decision). Plan approvals come from task leads.",
          role.projectId,
        );
      }
      if (input.taskId !== undefined) {
        return yield* teamError(
          "A PM's ask_user has no taskId: the card is about the project. A task's lead asks about its own task.",
          role.projectId,
        );
      }
      const item = yield* router.ask({
        task: null,
        projectId: role.projectId,
        kind: input.kind,
        question: input.question,
        context: input.context,
        options: input.options ?? [],
        askerThreadId: callerThreadId,
      });
      return { item };
    });

  /**
   * The Director's decision card: about a task in any project, shown in the Director's
   * chat, answered back to the Director, who relays it to that project's PM.
   */
  const askAsDirector = (
    callerThreadId: ThreadId,
    role: Extract<ProjectTeamRole, { readonly type: "director" }>,
    input: ProjectTeamAskUserInput,
  ) =>
    Effect.gen(function* () {
      if (input.kind !== "decision") {
        return yield* teamError(
          "The Director asks the user only for decisions (kind: decision). Plan approvals and blockers come from task leads.",
          role.projectId,
        );
      }
      if (input.taskId === undefined) {
        return yield* teamError(
          "The Director's ask_user needs taskId: the task the decision is mainly about.",
          role.projectId,
        );
      }
      const task = yield* requireAnyTask(input.taskId, role.projectId);
      const item = yield* router.ask({
        task,
        projectId: role.projectId,
        kind: "decision",
        question: input.question,
        context: input.context,
        options: input.options ?? [],
        askerThreadId: callerThreadId,
      });
      yield* appendEvent(task, "note", "The Director asked the user (decision).", callerThreadId);
      return { item };
    });

  // Restore before relaying so even an immediately failed retry can open a new blocker.
  const restoreFailedTurnStage = (item: ProjectAttentionItem, answer: string) =>
    Effect.gen(function* () {
      if (
        !isTurnFailedBlocker(item) ||
        item.taskId === null ||
        item.answeredAt !== null ||
        item.supersededAt !== null ||
        answer.split("\nNote:")[0]?.trim() !== TURN_FAILED_RETRY
      ) {
        return;
      }
      const task = yield* requireTask(item.taskId, item.projectId);
      if (task.stage !== "blocked") {
        return;
      }
      const events = yield* repository.listTaskEvents({
        taskId: task.id,
        limit: Number.MAX_SAFE_INTEGER,
      });
      let blockedIndex = events.findLastIndex(
        (event) => event.kind === "stage_changed" && event.body.endsWith(" → blocked"),
      );
      // Failed delivery can leave restore/rollback pairs after the original failure.
      // Only cross system-written pairs; a lead's deliberate stage change stops the walk.
      while (blockedIndex >= 0) {
        const blocked = events[blockedIndex]!;
        if (events[blockedIndex - 1]?.kind === "outcome") {
          break;
        }
        const restoreIndex = events.findLastIndex(
          (event, index) => index < blockedIndex && event.kind === "stage_changed",
        );
        const restore = events[restoreIndex];
        const previousBlockIndex = events.findLastIndex(
          (event, index) => index < restoreIndex && event.kind === "stage_changed",
        );
        const previousBlock = events[previousBlockIndex];
        const stage = blocked.body.split(" → ")[0];
        if (
          blocked.actorThreadId !== null ||
          restore?.actorThreadId !== null ||
          restore.body !== `blocked → ${stage}` ||
          previousBlock?.actorThreadId !== null ||
          previousBlock.body !== blocked.body
        ) {
          break;
        }
        blockedIndex = previousBlockIndex;
      }
      const blocked = events[blockedIndex];
      const outcome = events[blockedIndex - 1];
      // Only undo a block written alongside a failed outcome, never a lead's deliberate block.
      if (
        blocked === undefined ||
        blocked.actorThreadId !== null ||
        outcome?.kind !== "outcome" ||
        !(outcome.body === "failed" || outcome.body.startsWith("failed:"))
      ) {
        return;
      }
      const previous = blocked.body.split(" → ")[0];
      const stage =
        Schema.is(ProjectTaskStage)(previous) && previous !== "blocked" ? previous : "running";
      const restored = yield* setTask({ id: task.id, stage });
      yield* appendEvent(restored, "stage_changed", `blocked → ${stage}`, null);
      yield* router.publish(task.projectId);
      return restored;
    });

  const answerAttention: ProjectTeamService["Service"]["answerAttention"] = (
    callerThreadId,
    input,
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm"], "attention_answer");
      const item = yield* repository.getAttentionItem(input.attentionItemId);
      if (Option.isNone(item) || item.value.projectId !== role.projectId) {
        return yield* teamError(
          `Attention item ${input.attentionItemId} was not found in this project.`,
          role.projectId,
        );
      }
      // Decisions are the user's call: the PM may only relay words the user
      // typed in its chat after the card appeared. Blockers carry facts and need no check.
      // A closed card skips the check so the router reports why it cannot be answered.
      const open = item.value.answeredAt === null && item.value.supersededAt === null;
      if (open && item.value.kind !== "blocker") {
        const { messages } = yield* threads.getThreadRecords(callerThreadId, ["messages"], {
          messageRoles: ["user"],
        });
        if (!isUserChatAnswer(input.answer, messages, isoMillis(item.value.createdAt))) {
          return yield* teamError(PM_RELAY_NOT_USER_WORDS, role.projectId);
        }
      }
      // Cancelling must stop the lead without starting another turn with the answer.
      const cancel =
        item.value.answeredAt === null &&
        item.value.supersededAt === null &&
        isTurnFailedBlocker(item.value) &&
        input.answer.split("\nNote:")[0]?.trim() === TURN_FAILED_CANCEL;
      if (cancel && item.value.taskId !== null) {
        yield* updateTask(
          callerThreadId,
          {
            taskId: item.value.taskId,
            stage: "cancelled",
            note: "사용자가 실패 블로커에서 태스크를 취소했어요.",
          },
          item.value,
        );
      }
      const restored = yield* restoreFailedTurnStage(item.value, input.answer);
      const answered = yield* router
        .answer({
          item: item.value,
          answer: input.answer,
          senderThreadId: callerThreadId,
          // The PM relaying the answer to its own card already has it.
          relay: !cancel && item.value.askerThreadId !== callerThreadId,
          answeredBy: "pm",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (restored !== undefined) {
                // The retried turn may already have failed and blocked the task again.
                const current = yield* requireTask(restored.id, restored.projectId);
                yield* moveTaskStage(current, "blocked", null);
              }
              return yield* Effect.failCause(cause);
            }),
          ),
        );
      yield* afterPlanApprovalAnswer(answered, callerThreadId);
      return { item: answered };
    }).pipe(orTeamError("Could not answer the question."));

  const dismissAttention: ProjectTeamService["Service"]["dismissAttention"] = (
    callerThreadId,
    input,
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(
        callerThreadId,
        ["pm", "lead", "director"],
        "attention_dismiss",
      );
      const item = yield* repository.getAttentionItem(input.attentionItemId);
      if (Option.isNone(item) || item.value.projectId !== role.projectId) {
        return yield* teamError(
          `Attention item ${input.attentionItemId} was not found in this project.`,
          role.projectId,
        );
      }
      if (role.type !== "pm" && item.value.askerThreadId !== callerThreadId) {
        return yield* teamError(
          role.type === "lead"
            ? "A task lead can only close its own questions. Ask the PM if another question is moot."
            : "The Director can only close its own decision cards.",
          role.projectId,
        );
      }
      if (role.type === "director" && item.value.kind !== "decision") {
        return yield* teamError("The Director can only close decision cards.", role.projectId);
      }
      const taskId = item.value.taskId;
      const task =
        taskId === null
          ? null
          : role.type === "director"
            ? yield* requireAnyTask(taskId, role.projectId)
            : { id: taskId, projectId: item.value.projectId };
      const dismissed = yield* router.dismiss({
        item: item.value,
        reason: input.reason,
        senderThreadId: callerThreadId,
        // The PM closing its own card needs no message about it.
        notifyAsker: role.type === "pm" && item.value.askerThreadId !== callerThreadId,
      });
      if (task !== null) {
        yield* appendEvent(task, "note", `Question closed: ${input.reason}`, callerThreadId);
      }
      return { item: dismissed };
    }).pipe(orTeamError("Could not close the question."));

  const taskKeyPrefixFor = (projectId: ProjectId, settings: ProjectTeamSettings) =>
    Effect.gen(function* () {
      if (settings.taskKeyPrefix !== undefined) return settings.taskKeyPrefix;
      const project = yield* projects.get(projectId);
      return defaultTaskKeyPrefix(Option.isSome(project) ? project.value.title : "");
    });

  const taskDetail = (task: ProjectTask) =>
    Effect.gen(function* () {
      const manager = yield* requireManager(task.projectId);
      const prefix = yield* taskKeyPrefixFor(task.projectId, manager.settings);
      return {
        task,
        key: formatTaskKey(prefix, task.number),
        versions: yield* repository.listSpecVersions(task.id),
        sessions: yield* repository.listTaskSessions(task.id),
        children: (yield* repository.listChildTasks(task.id)).map((child) => toTaskBrief(child)),
        openAttention: yield* repository.listOpenAttentionItems({
          projectId: task.projectId,
          taskId: task.id,
        }),
      } satisfies ProjectTeamTaskDetail;
    });

  const latestSpec = (task: ProjectTask) =>
    repository.getLatestSpecVersion(task.id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(teamError(`#${task.number} has no spec.`, task.projectId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** Stores the user's spec as the next version while holding the task's spec lock. */
  const appendUserSpec = (task: ProjectTask, spec: ProjectTaskSpec, note: string) =>
    Effect.gen(function* () {
      const version = yield* repository.appendSpecVersion({
        taskId: task.id,
        spec,
        author: "user",
        authorThreadId: null,
        note,
        createdAt: yield* nowIso,
      });
      yield* appendEvent(task, "note", `Spec v${version.version}: ${note}`, null);
      yield* closeStaleApproval(task, version, "user", null);
      return version;
    });

  const getTaskDetail: ProjectTeamService["Service"]["getTaskDetail"] = (input) =>
    requireTask(input.taskId, input.projectId).pipe(
      Effect.flatMap(taskDetail),
      orTeamError("Could not read the task.", input.projectId),
    );

  const setTaskRoleModels: ProjectTeamService["Service"]["setTaskRoleModels"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId, input.projectId);
      const updated = yield* repository.setTaskRoleModels({
        id: task.id,
        roleModels: applyRoleModelsPatch(task.roleModels, input.roleModels),
        now: yield* nowIso,
      });
      const next = Option.getOrElse(updated, () => task);
      yield* router.publish(task.projectId);
      return yield* taskDetail(next);
    }).pipe(orTeamError("Could not set the task's models.", input.projectId));

  const moveTask: ProjectTeamService["Service"]["moveTask"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId, input.projectId);
      // Children on the lead's checkout run where it runs: none may be mid-turn during a move.
      const sharedChildren = (lead: ThreadId, worktreePath: string, live: boolean) =>
        threads.listProjectThreads({ projectId: task.projectId, includeSubagents: true }).pipe(
          Effect.map((shells) =>
            (live ? liveTaskChildren : taskChildren)(shells, lead).filter(
              (child) => child.worktreePath === worktreePath,
            ),
          ),
          orTeamError("Could not list the task's child sessions.", task.projectId),
        );
      if (task.leadThreadId !== null) {
        const leadShell = yield* threads
          .getThreadShell(task.leadThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (leadShell?.worktreePath != null) {
          const working = yield* sharedChildren(task.leadThreadId, leadShell.worktreePath, true);
          if (working.length > 0) {
            return yield* teamError(
              `리드가 맡긴 작업(${working.map((child) => child.title).join(", ")})이 아직 진행 중이라 옮길 수 없어요. 끝난 뒤 다시 옮겨 주세요.`,
              task.projectId,
            );
          }
        }
      }
      const moved = yield* moveTaskLead(
        {
          threads,
          cloudLead,
          gate: leadMoveGate,
          providers: providerRegistry.getProviders,
          setMove: ({ task: target, ...rest }) =>
            Effect.flatMap(nowIso, (now) =>
              repository.setTaskMove({ id: target.id, now, ...rest }),
            ).pipe(orTeamError("Could not record the move.", target.projectId)),
          note: (target, body) =>
            appendEvent(target, "note", body, null).pipe(
              orTeamError("Could not note the move.", target.projectId),
            ),
          publish: (target) => router.publish(target.projectId),
          newKey: (prefix) => newId(prefix).pipe(Effect.orDie),
          isFinished: (target) => FinishedTaskCleanup.isFinishedStage(target.stage),
          sharedChildren: (lead, worktreePath) =>
            sharedChildren(lead, worktreePath, false).pipe(
              Effect.map((children) => children.map((child) => child.id)),
            ),
        },
        task,
        input.to,
      ).pipe(Effect.mapError((error) => teamError(error.detail, task.projectId)));
      // A lead paused for memory and moved away no longer waits for this Mac's
      // memory; the governor lets its held messages run.
      const released =
        moved.memoryHold == null
          ? moved
          : Option.getOrElse(yield* setMemoryHold(moved, null), () => moved);
      return yield* taskDetail(released);
    }).pipe(orTeamError("Could not move the task.", input.projectId));

  /**
   * A move cut short by a server restart: the task stays where it was, its lead's
   * thread is pointed back there, and its held messages run.
   */
  const recoverInterruptedMoves = Effect.gen(function* () {
    for (const task of yield* repository.listMovingTasks()) {
      yield* repository.setTaskMove({ id: task.id, moveTarget: null, now: yield* nowIso });
      if (task.leadThreadId !== null) {
        const lead = task.leadThreadId;
        const key = yield* newId("task-move:recover");
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${key}:location`),
            threadId: lead,
            location: task.location ?? "local",
          })
          .pipe(Effect.ignore);
        yield* threads
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${key}:resume`),
            threadId: lead,
          })
          .pipe(Effect.ignore);
      }
      yield* appendEvent(
        task,
        "note",
        "서버가 다시 시작돼 리드 이동이 중단됐어요. 위치는 그대로예요.",
        null,
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not recover interrupted moves", { cause }),
    ),
  );

  /**
   * A cloud lead's sandbox could not be replaced before its lifetime limit: ask the user
   * whether to bring the lead to the Mac, once per open card.
   */
  const raiseSandboxRotationDecision = (leadThreadId: ThreadId, reason: string) =>
    Effect.gen(function* () {
      const found = yield* repository.findTaskByLeadThreadId(leadThreadId);
      if (Option.isNone(found)) return;
      const task = found.value;
      if (!LIVE_TASK_STAGES.has(task.stage) || task.location !== "cloud") return;
      const open = yield* repository.listOpenAttentionItems({
        projectId: task.projectId,
        taskId: task.id,
      });
      if (open.some(isSandboxRotationDecision)) return;
      const who = `${yield* keyOf(task)} ${task.title}`;
      yield* router.ask({
        task,
        kind: "decision",
        question: `${who}: 클라우드 샌드박스를 새로 바꾸지 못했어요\n\n이유: ${reason}\n\n지금 샌드박스는 사용 시간이 끝나면 멈춰요. 로컬로 가져오면 지금까지의 작업과 대화를 그대로 이어가요.`,
        options: SANDBOX_ROTATION_OPTIONS,
        askerThreadId: leadThreadId,
        context: {
          action: "클라우드 리드를 어디서 계속할지 정합니다",
          reason: `${who}: 샌드박스 사용 시간이 곧 끝나는데 새 샌드박스로 옮기지 못했어요.`,
          impacts: [],
          cost: null,
          reversibility: "reversible",
          recommendation: "작업이 끊기지 않도록 '로컬로 가져오기'를 추천해요.",
        },
      });
      yield* appendEvent(task, "note", "클라우드 샌드박스 교체에 실패해 결정을 요청했어요.", null);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not raise the sandbox rotation decision", { leadThreadId, cause }),
      ),
    );

  const leadControlDeps = {
    threads,
    gate: leadMoveGate,
    newKey: (prefix: string) => newId(prefix).pipe(Effect.orDie),
  };
  yield* cloudLead.setRotationHandler({
    // A move mirrors and releases the sandbox itself.
    busy: (lead) => leadMoveGate.isHeldFor(lead, "move"),
    interrupt: (lead) =>
      Effect.gen(function* () {
        leadMoveGate.hold(lead, "rotation");
        yield* leadControl(leadControlDeps, lead, "rotation").stopTurn;
      }).pipe(Effect.orDie),
    resume: (lead) =>
      Effect.gen(function* () {
        const control = leadControl(leadControlDeps, lead, "rotation");
        // A move that began meanwhile tells the lead where it continues.
        const stillCloud =
          !leadMoveGate.isHeldFor(lead, "move") &&
          (yield* threads.getThreadShell(lead).pipe(
            Effect.map((shell) => shell?.location === "cloud"),
            Effect.orElseSucceed(() => false),
          ));
        if (stillCloud) {
          yield* control
            .tellLead("[교체] 새 클라우드 샌드박스에서 이어가요.")
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* control.resumeQueue;
      }),
    failed: raiseSandboxRotationDecision,
  });

  const updateTaskSpec: ProjectTeamService["Service"]["updateTaskSpec"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId, input.projectId);
      yield* specLocks.withLock(
        task.id,
        Effect.gen(function* () {
          const latest = yield* latestSpec(task);
          if (latest.version !== input.baseVersion) {
            return yield* teamError(
              `The spec changed to v${latest.version} while you edited v${input.baseVersion}.`,
              task.projectId,
            );
          }
          yield* appendUserSpec(task, input.spec, input.note || "Edited by the user");
        }),
      );
      yield* router.publish(task.projectId);
      return yield* taskDetail(task);
    }).pipe(orTeamError("Could not update the spec.", input.projectId));

  const restoreTaskSpec: ProjectTeamService["Service"]["restoreTaskSpec"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId, input.projectId);
      yield* specLocks.withLock(
        task.id,
        Effect.gen(function* () {
          const versions = yield* repository.listSpecVersions(task.id);
          const source = versions.find((version) => version.version === input.version);
          if (source === undefined) {
            return yield* teamError(`#${task.number} has no v${input.version}.`, task.projectId);
          }
          yield* appendUserSpec(task, source.spec, `Restored v${input.version}`);
        }),
      );
      yield* router.publish(task.projectId);
      return yield* taskDetail(task);
    }).pipe(orTeamError("Could not restore the spec.", input.projectId));

  const splitTaskTodo: ProjectTeamService["Service"]["splitTaskTodo"] = (input) =>
    Effect.gen(function* () {
      const parent = yield* requireTask(input.taskId, input.projectId);
      const subtask = yield* specLocks.withLock(
        parent.id,
        Effect.gen(function* () {
          const latest = yield* latestSpec(parent);
          const todo = latest.spec.todos.find((candidate) => candidate.id === input.todoId);
          if (todo === undefined) {
            return yield* teamError(`#${parent.number} has no such todo.`, parent.projectId);
          }
          if (todo.subtaskId !== null) {
            return yield* teamError(`"${todo.text}" is already its own task.`, parent.projectId);
          }
          const subtask = yield* repository.createTask({
            id: ProjectTaskId.make(yield* newId("task")),
            projectId: parent.projectId,
            title: clip(todo.text, 500),
            request: todo.text,
            waitsOn: [],
            parentTaskId: parent.id,
            spec: emptyProjectTaskSpec(todo.text),
            now: yield* nowIso,
            author: "user",
            authorThreadId: null,
          });
          yield* appendEvent(subtask, "created", subtask.title, null);
          yield* appendUserSpec(
            parent,
            {
              ...latest.spec,
              todos: latest.spec.todos.map((candidate) =>
                candidate.id === todo.id ? { ...candidate, subtaskId: subtask.id } : candidate,
              ),
            },
            `Split "${clip(todo.text, 80)}" into its own task`,
          );
          return subtask;
        }),
      );
      yield* router.publish(parent.projectId);
      return { subtask, parent: yield* taskDetail(parent) };
    }).pipe(orTeamError("Could not split the todo.", input.projectId));

  const answerDecision: ProjectTeamService["Service"]["answerDecision"] = (input) =>
    Effect.gen(function* () {
      const manager = yield* requireManager(input.projectId);
      const item = yield* repository.getAttentionItem(input.attentionItemId);
      if (Option.isNone(item) || item.value.projectId !== input.projectId) {
        return yield* teamError(
          `Attention item ${input.attentionItemId} was not found in this project.`,
          input.projectId,
        );
      }
      // Cancelling must stop the lead without starting another turn with the answer.
      const cancel =
        item.value.answeredAt === null &&
        item.value.supersededAt === null &&
        isTurnFailedBlocker(item.value) &&
        input.answer.split("\nNote:")[0]?.trim() === TURN_FAILED_CANCEL;
      if (cancel && item.value.taskId !== null) {
        yield* updateTask(
          manager.threadId,
          {
            taskId: item.value.taskId,
            stage: "cancelled",
            note: "사용자가 실패 블로커에서 태스크를 취소했어요.",
          },
          item.value,
        );
      }
      // A sandbox that could not be replaced: the lead comes to the Mac before the card closes.
      const rotation = isSandboxRotationDecision(item.value);
      if (
        rotation &&
        item.value.answeredAt === null &&
        item.value.supersededAt === null &&
        item.value.taskId !== null &&
        input.answer.split("\nNote:")[0]?.trim() === SANDBOX_ROTATION_MOVE_LOCAL
      ) {
        const task = yield* requireTask(item.value.taskId, item.value.projectId);
        if (task.location === "cloud") {
          yield* moveTask({ projectId: task.projectId, taskId: task.id, to: "local" });
        }
      }
      const restored = yield* restoreFailedTurnStage(item.value, input.answer);
      const answered = yield* router
        .answer({
          item: item.value,
          answer: input.answer,
          senderThreadId: manager.threadId,
          relay: !cancel && !rotation,
          answeredBy: "user",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (restored !== undefined) {
                // The retried turn may already have failed and blocked the task again.
                const current = yield* requireTask(restored.id, restored.projectId);
                yield* moveTaskStage(current, "blocked", null);
              }
              return yield* Effect.failCause(cause);
            }),
          ),
        );
      if (answered.taskId !== null) {
        // The Director's cards are about tasks in other projects.
        const task = yield* requireAnyTask(answered.taskId, answered.projectId);
        yield* appendEvent(task, "note", `The user answered (${answered.kind}).`, null);
      }
      yield* afterPlanApprovalAnswer(answered, null);
      return { item: answered };
    }).pipe(orTeamError("Could not answer the question.", input.projectId));

  const askLead: ProjectTeamService["Service"]["askLead"] = (input) =>
    Effect.gen(function* () {
      const manager = yield* requireManager(input.projectId);
      const item = yield* repository.getAttentionItem(input.attentionItemId);
      if (Option.isNone(item) || item.value.projectId !== input.projectId) {
        return yield* teamError(
          `Attention item ${input.attentionItemId} was not found in this project.`,
          input.projectId,
        );
      }
      // A card without a task came from the PM, which answers questions about it itself.
      if (item.value.taskId === null) {
        const askerThreadId = item.value.askerThreadId ?? manager.threadId;
        const key = `project-team:ask-lead:${yield* newId(item.value.id)}`;
        yield* threads.sendToThread({
          projectId: item.value.projectId,
          commandId: CommandId.make(key),
          threadId: askerThreadId,
          messageId: MessageId.make(key),
          senderThreadId: manager.threadId,
          text: formatLeadQuestion({
            cardId: item.value.id,
            cardLabel: `${LEAD_QUESTION_CARD_LABEL[item.value.kind]} · ${resolvePersona(manager.projectId, manager.settings).name}`,
            question: input.question,
            quotes: input.quotes,
          }),
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        });
        return { messageId: key };
      }
      // The task's own lead: on a Director card the asker is the Director, not the lead.
      const task = yield* requireAnyTask(item.value.taskId, item.value.projectId);
      const leadThreadId = task.leadThreadId;
      if (leadThreadId === null) {
        return yield* teamError(`Task ${task.id} has no task lead to ask yet.`, input.projectId);
      }
      const key = `project-team:ask-lead:${yield* newId(item.value.id)}`;
      yield* threads.sendToThread({
        projectId: task.projectId,
        commandId: CommandId.make(key),
        threadId: leadThreadId,
        messageId: MessageId.make(key),
        senderThreadId: manager.threadId,
        text: formatLeadQuestion({
          cardId: item.value.id,
          cardLabel: `${LEAD_QUESTION_CARD_LABEL[item.value.kind]} · ${yield* keyOf(task)} ${task.title}`,
          question: input.question,
          quotes: input.quotes,
        }),
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      });
      yield* appendEvent(task, "note", "사용자가 카드에서 리드에게 질문했어요.", null);
      return { messageId: key };
    }).pipe(orTeamError("Could not send the question to the lead.", input.projectId));

  /**
   * Wakes the PM of every other project with an inbox task that this task just cleared:
   * all of that task's waitsOn are now in review or done. Its own PM hears it from the
   * outcome wake, so same-project tasks are left out.
   */
  const wakeUnblockedProjects = (dependency: ProjectTask) =>
    Effect.gen(function* () {
      const waiting = (yield* repository.listTasksWaitingOn(dependency.id)).filter(
        (task) => task.projectId !== dependency.projectId && task.stage === "inbox",
      );
      if (waiting.length === 0) return;
      const readyByProject = new Map<ProjectId, Array<ProjectTask>>();
      for (const task of waiting) {
        let ready = true;
        for (const id of task.waitsOn) {
          if (id === dependency.id) continue;
          const other = yield* repository.getTask(id);
          if (Option.isNone(other) || !isDependencyCleared(other.value.stage)) ready = false;
        }
        if (!ready) continue;
        readyByProject.set(task.projectId, [...(readyByProject.get(task.projectId) ?? []), task]);
      }
      if (readyByProject.size === 0) return;
      const manager = yield* repository.getManager(dependency.projectId);
      const prefix = yield* taskKeyPrefixFor(
        dependency.projectId,
        Option.isSome(manager) ? manager.value.settings : DEFAULT_PROJECT_TEAM_SETTINGS,
      );
      const project = yield* projects.get(dependency.projectId);
      const from = Option.isSome(project) ? ` in ${project.value.title}` : "";
      const state = dependency.stage === "done" ? "done" : "in review";
      for (const [projectId, tasks] of readyByProject) {
        const ready = tasks.map((task) => `#${task.number} ${task.title}`).join(", ");
        yield* wakeManagerWith(
          projectId,
          `project-team:unblocked:${yield* newId(dependency.id)}`,
          `[Dependency cleared] ${formatTaskKey(prefix, dependency.number)} ${dependency.title}${from} is ${state}. Ready to start: ${ready}.`,
        );
      }
    }).pipe(
      // A missed wake only delays the start; the stage change itself must not fail.
      Effect.catchCause((cause) =>
        Effect.logWarning("waking PMs of unblocked tasks failed", {
          taskId: dependency.id,
          cause,
        }),
      ),
    );

  /**
   * Wakes the PM with the parent's approved subtasks that can start now: in the inbox,
   * covered by the approval, and with every waitsOn in review or done.
   */
  const wakeReadySubtasks = (parent: ProjectTask, why: string) =>
    Effect.gen(function* () {
      const inbox = (yield* repository.listChildTasks(parent.id)).filter(
        (child) => child.stage === "inbox",
      );
      const covered = yield* Effect.filter(inbox, (child) =>
        breakdownCoverage(child).pipe(Effect.map((by) => by !== null)),
      );
      if (covered.length === 0) return;
      const stages = new Map<string, ProjectTaskStage>();
      for (const id of new Set(covered.flatMap((child) => child.waitsOn))) {
        const dependency = yield* repository.getTask(id);
        if (Option.isSome(dependency)) stages.set(id, dependency.value.stage);
      }
      const { ready, waiting } = splitReadySubtasks(covered, (id) => stages.get(id));
      if (ready.length === 0) return;
      const list = (tasks: ReadonlyArray<ProjectTask>) =>
        tasks.map((task) => `#${task.number} ${task.title}`).join(", ");
      yield* wakeManagerWith(
        parent.projectId,
        `project-team:ready:${parent.id}:${ready.map((task) => task.id).join(",")}`,
        `[Ready to start] ${why} Start with task_start: ${list(ready)}.${
          waiting.length === 0 ? "" : ` Still waiting on other tasks: ${list(waiting)}.`
        }`,
      );
    }).pipe(
      // A missed wake only delays the start; the change that caused it must not fail.
      Effect.catchCause((cause) =>
        Effect.logWarning("waking the PM with ready subtasks failed", {
          taskId: parent.id,
          cause,
        }),
      ),
    );

  /** After a subtask is done: a parent whose subtasks are all finished becomes Done. */
  const finishParentIfDone = (subtask: ProjectTask): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (subtask.parentTaskId === null) return;
      const parent = yield* repository.getTask(subtask.parentTaskId);
      if (Option.isNone(parent)) return;
      // A Director epic follows its subtasks on its own; an unapproved parent is not done.
      if (parent.value.stage !== "running" && parent.value.stage !== "in_review") return;
      const manager = yield* repository.getManager(parent.value.projectId);
      if (Option.isNone(manager) || manager.value.kind !== "pm") return;
      const children = yield* repository.listChildTasks(parent.value.id);
      if (!allSubtasksDone(children)) return;
      const done = children.filter((child) => child.stage === "done").length;
      const result = `All ${done} of its subtasks are done.`;
      const finished = yield* setTask({
        id: parent.value.id,
        stage: "done",
        resultSummary: result,
      });
      yield* appendEvent(finished, "stage_changed", `${parent.value.stage} → done`, null);
      yield* appendEvent(finished, "summary", `Result: ${result}`, null);
      yield* sitreps.noteMilestone(finished.projectId);
      yield* finishedTasks.archiveLead(finished, { stopLead: false });
      yield* wakeManagerWith(
        finished.projectId,
        `project-team:parent-done:${finished.id}`,
        `#${finished.number} done: ${finished.title} · ${result}`,
      );
      yield* router.publish(finished.projectId);
      // A finished parent may finish its own parent in turn.
      yield* finishParentIfDone(finished);
    }).pipe(
      // The subtask's own update stands even if the parent cannot be finished.
      Effect.catchCause((cause) =>
        Effect.logWarning("finishing a parent task failed", { taskId: subtask.id, cause }),
      ),
    );

  /** Queues a short server message for the PM, once per key; skipped when the PM is off or gone. */
  const wakeManagerWith = (projectId: ProjectId, key: string, text: string) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(projectId);
      if (Option.isNone(manager) || !manager.value.settings.enabled) return;
      const shell = yield* threads.getThreadShell(manager.value.threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: manager.value.threadId,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
    }).pipe(
      // The card is already on screen; a missed wake only costs the PM's recommendation.
      Effect.catchCause((cause) => Effect.logWarning("waking the PM failed", { projectId, cause })),
    );

  const listMemory: ProjectTeamService["Service"]["listMemory"] = (callerThreadId) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "memory_list");
      return { entries: yield* repository.listMemory(role.projectId) };
    }).pipe(orTeamError("Could not read the project memory."));

  const writeMemory: ProjectTeamService["Service"]["writeMemory"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead", "director"], "memory_write");
      if (input.topic === PROJECT_SUMMARY_TOPIC) {
        const lines = input.content.split("\n").filter((line) => line.trim() !== "").length;
        if (lines > PROJECT_SUMMARY_MAX_LINES) {
          return yield* teamError(
            `The "${PROJECT_SUMMARY_TOPIC}" topic holds at most ${PROJECT_SUMMARY_MAX_LINES} lines; it has ${lines}. Shorten it to what the Director needs: the project's goal, what is in flight and what is next.`,
            role.projectId,
          );
        }
      }
      const briefing = role.type === "director" && input.topic === DIRECTOR_BRIEFING_TOPIC;
      if (briefing) {
        const lines = input.content.split("\n").filter((line) => line.trim() !== "").length;
        if (lines > 1) {
          return yield* teamError(
            `The "${DIRECTOR_BRIEFING_TOPIC}" topic holds one line; it has ${lines}. Say the one thing about the goals the user should know now.`,
            role.projectId,
          );
        }
      }
      const entry = yield* repository.upsertMemory({
        id: ProjectMemoryEntryId.make(yield* newId("memory")),
        projectId: role.projectId,
        topic: input.topic,
        content: input.content,
        updatedAt: yield* nowIso,
      });
      // All projects shows the direction and briefing, so their change goes out with a new snapshot.
      if (input.topic === PROJECT_DIRECTION_TOPIC || briefing) {
        yield* router.publish(role.projectId);
      }
      return { entry };
    }).pipe(orTeamError("Could not write the project memory."));

  const deleteMemory: ProjectTeamService["Service"]["deleteMemory"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "director"], "memory_delete");
      const deleted = yield* repository.deleteMemory({
        projectId: role.projectId,
        topic: input.topic,
      });
      if (
        deleted &&
        (input.topic === PROJECT_DIRECTION_TOPIC ||
          (role.type === "director" && input.topic === DIRECTOR_BRIEFING_TOPIC))
      ) {
        yield* router.publish(role.projectId);
      }
      return { topic: input.topic, deleted };
    }).pipe(orTeamError("Could not delete the project memory."));

  const requireGoal = (goalId: WorkspaceGoalId, projectId: ProjectId) =>
    Effect.gen(function* () {
      const goals = yield* repository.listWorkspaceGoals();
      const goal = goals.find((candidate) => candidate.id === goalId);
      if (goal === undefined) {
        return yield* teamError(`Goal ${goalId} was not found.`, projectId);
      }
      return goal;
    });

  const saveGoal = (goal: WorkspaceGoal, projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* repository.saveWorkspaceGoal(goal);
      // The Director's summary carries the goals, so a change goes out with a new snapshot.
      yield* router.publish(projectId);
      return { goal };
    });

  const goalWrite: ProjectTeamService["Service"]["goalWrite"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["director"], "goal_write");
      return yield* goalLocks.withLock("goals", writeGoal(role.projectId, input));
    }).pipe(orTeamError("Could not write the goal."));

  const writeGoal = (projectId: ProjectId, input: ProjectTeamGoalWriteInput) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const detail =
        input.detail === undefined ? undefined : input.detail === "" ? null : input.detail;
      if (input.goalId === undefined || input.goalId === null) {
        if (input.title === undefined) {
          return yield* teamError("A new goal needs a title.", projectId);
        }
        const goals = yield* repository.listWorkspaceGoals();
        return yield* saveGoal(
          {
            id: WorkspaceGoalId.make(yield* newId("goal")),
            title: input.title,
            detail: detail ?? null,
            status: input.status ?? "active",
            position: input.position ?? Math.max(-1, ...goals.map((goal) => goal.position)) + 1,
            links: [],
            createdAt: now,
            updatedAt: now,
          },
          projectId,
        );
      }
      const goal = yield* requireGoal(input.goalId, projectId);
      return yield* saveGoal(
        {
          ...goal,
          title: input.title ?? goal.title,
          detail: detail === undefined ? goal.detail : detail,
          status: input.status ?? goal.status,
          position: input.position ?? goal.position,
          updatedAt: now,
        },
        projectId,
      );
    });

  const goalLink: ProjectTeamService["Service"]["goalLink"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["director"], "goal_link");
      return yield* goalLocks.withLock("goals", linkGoal(role.projectId, input));
    }).pipe(orTeamError("Could not link the goal."));

  const linkGoal = (projectId: ProjectId, input: ProjectTeamGoalLinkInput) =>
    Effect.gen(function* () {
      const linkProjects = input.link?.projectIds ?? [];
      const linkTasks = input.link?.taskIds ?? [];
      const unlinkProjects = new Set<string>(input.unlink?.projectIds ?? []);
      const unlinkTasks = new Set<string>(input.unlink?.taskIds ?? []);
      if (linkProjects.length + linkTasks.length + unlinkProjects.size + unlinkTasks.size === 0) {
        return yield* teamError("goal_link needs projects or tasks to link or unlink.", projectId);
      }
      const goal = yield* requireGoal(input.goalId, projectId);
      const added: Array<WorkspaceGoalLink> = [];
      for (const linkedProjectId of linkProjects) {
        const project = yield* projects.get(linkedProjectId);
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* teamError(`Project ${linkedProjectId} was not found.`, projectId);
        }
        added.push({ projectId: linkedProjectId, taskId: null });
      }
      for (const taskId of linkTasks) {
        const task = yield* requireAnyTask(taskId, projectId);
        added.push({ projectId: task.projectId, taskId: task.id });
      }
      const sameLink = (a: WorkspaceGoalLink, b: WorkspaceGoalLink) =>
        a.projectId === b.projectId && a.taskId === b.taskId;
      const links: Array<WorkspaceGoalLink> = goal.links.filter((link) =>
        link.taskId === null ? !unlinkProjects.has(link.projectId) : !unlinkTasks.has(link.taskId),
      );
      for (const link of added) {
        if (!links.some((existing) => sameLink(existing, link))) links.push(link);
      }
      return yield* saveGoal({ ...goal, links, updatedAt: yield* nowIso }, projectId);
    });

  const pmNudge: ProjectTeamService["Service"]["pmNudge"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["director"], "pm_nudge");
      const task = yield* requireAnyTask(input.taskId, role.projectId);
      if (task.projectId !== input.projectId) {
        return yield* teamError(
          `Task ${task.id} is not in project ${input.projectId}.`,
          role.projectId,
        );
      }
      if (FinishedTaskCleanup.isFinishedStage(task.stage)) {
        return yield* teamError(`#${task.number} is already ${task.stage}.`, role.projectId);
      }
      const manager = yield* repository.getManager(input.projectId);
      if (Option.isNone(manager) || manager.value.kind !== "pm") {
        return yield* teamError(`Project ${input.projectId} has no PM.`, role.projectId);
      }
      if (!manager.value.settings.enabled) {
        return yield* teamError(`The PM of ${input.projectId} is turned off.`, role.projectId);
      }
      const now = yield* nowIso;
      const events = yield* repository.listTaskEvents({
        taskId: task.id,
        limit: Number.MAX_SAFE_INTEGER,
      });
      const last = events.findLast(
        (event) => event.kind === "note" && event.body.startsWith(PM_NUDGE_NOTE_PREFIX),
      );
      // A new answer about this task gives the Director news to relay.
      const answeredSince =
        last !== undefined &&
        (yield* repository.listRecentClosedAttentionItems({
          projectId: role.projectId,
          limit: PM_NUDGE_ANSWER_LOOKBACK,
        })).some(
          (item) =>
            item.kind === "decision" &&
            item.taskId === task.id &&
            item.answeredAt !== null &&
            isoMillis(item.answeredAt) > isoMillis(last.createdAt),
        );
      if (
        last !== undefined &&
        !answeredSince &&
        isoMillis(now) - isoMillis(last.createdAt) < PM_NUDGE_INTERVAL_MS
      ) {
        return {
          status: "skipped",
          nextAllowedAt: isoFromMillis(isoMillis(last.createdAt) + PM_NUDGE_INTERVAL_MS),
        } satisfies ProjectTeamPmNudgeResult;
      }
      const key = `project-team:pm-nudge:${yield* newId(task.id)}`;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: manager.value.threadId,
        messageId: MessageId.make(key),
        text: `[디렉터] ${yield* keyOf(task)} ${task.title}\n${input.message}`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* appendEvent(task, "note", `${PM_NUDGE_NOTE_PREFIX}${input.message}`, callerThreadId);
      return { status: "sent", nextAllowedAt: null } satisfies ProjectTeamPmNudgeResult;
    }).pipe(orTeamError("Could not nudge the PM."));

  const goalAlignmentReport: ProjectTeamService["Service"]["goalAlignmentReport"] = Effect.gen(
    function* () {
      const managers = yield* repository.listManagers();
      const director = managers.find((manager) => manager.kind === "director");
      if (director === undefined) return Option.none();
      const alignable: Array<AlignableTask> = [];
      const projectIds: Array<ProjectId> = [];
      const tasks = new Map<string, { key: string; title: string; projectTitle: string }>();
      // Same projects as team_status: the Director's own and every PM's project not deleted.
      for (const manager of managers) {
        if (manager.kind !== "pm" && manager !== director) continue;
        const project = yield* projects.get(manager.projectId);
        if (manager.kind === "pm" && (Option.isNone(project) || project.value.deletedAt !== null)) {
          continue;
        }
        projectIds.push(manager.projectId);
        const projectTasks = yield* repository.listTasks({ projectId: manager.projectId });
        const openAttention = yield* repository.listOpenAttentionItems({
          projectId: manager.projectId,
        });
        alignable.push(...projectTasks.map((task) => toAlignableTask(task, openAttention)));
        const prefix = yield* taskKeyPrefixFor(manager.projectId, manager.settings);
        const projectTitle = Option.isSome(project) ? project.value.title : manager.projectId;
        for (const task of projectTasks) {
          tasks.set(task.id, {
            key: formatTaskKey(prefix, task.number),
            title: task.title,
            projectTitle,
          });
        }
      }
      const goals = yield* repository.listWorkspaceGoals();
      return Option.some({
        director,
        goals,
        alignment: alignWorkspaceGoals({ goals, tasks: alignable, projectIds }),
        tasks,
      } satisfies GoalAlignmentReport);
    },
  ).pipe(orTeamError("Could not read the goal alignment."));

  const requestSitrep: ProjectTeamService["Service"]["requestSitrep"] = ({ projectId }) =>
    sitreps.request(projectId).pipe(Effect.map((sitrepId) => ({ sitrepId })));

  const lastManagerAction = (manager: ProjectTeamRepository.ProjectManagerRecord) =>
    Effect.gen(function* () {
      const event = yield* repository.getLatestEventByActor({
        projectId: manager.projectId,
        actorThreadId: manager.threadId,
      });
      if (Option.isNone(event)) return null;
      const task =
        event.value.taskId === null ? Option.none() : yield* repository.getTask(event.value.taskId);
      return {
        text: describeManagerAction(event.value, Option.isSome(task) ? task.value : null),
        at: event.value.createdAt,
      } satisfies ProjectManagerLastAction;
    });

  const managerPresence = (
    manager: ProjectTeamRepository.ProjectManagerRecord,
    openAttention: ReadonlyArray<ProjectAttentionItem>,
    latestSitrep: Option.Option<{ readonly createdAt: IsoDateTime }>,
    otherThreadsWaiting: number,
  ) =>
    Effect.gen(function* () {
      const tasks = yield* repository.listTasks({
        projectId: manager.projectId,
        stages: PRESENCE_TASK_STAGES,
      });
      const isStalled = (task: ProjectTask) =>
        task.lastOutcome === "stalled" && LIVE_TASK_STAGES.has(task.stage);
      const live = tasks.filter((task) => LIVE_TASK_STAGES.has(task.stage));
      const askingTaskIds = new Set(openAttention.map((item) => item.taskId));
      // Running means a lead is working: not in review, not stalled, not waiting on the user.
      const running = tasks.filter(
        (task) =>
          (SitrepScheduler.ACTIVE_TASK_STAGES as ReadonlyArray<string>).includes(task.stage) &&
          !isStalled(task) &&
          !askingTaskIds.has(task.id),
      );
      // Mirrors SitrepScheduler: the next interval sitrep is due one interval after the
      // later of the window start and the latest attempt.
      const nextSitrepAt = manager.settings.enabled
        ? isoFromMillis(
            Math.max(
              isoMillis(manager.lastSitrepAt ?? manager.createdAt),
              Option.isSome(latestSitrep) ? isoMillis(latestSitrep.value.createdAt) : 0,
            ) +
              manager.settings.sitrepIntervalMinutes * MINUTE_MS,
          )
        : null;
      return {
        running: running.length,
        // Same unit as the summary's openCount: open questions, not tasks.
        waitingOnUser: openAttention.length + otherThreadsWaiting,
        stalled: live.filter(isStalled).length,
        inbox: tasks.filter((task) => task.stage === "inbox").length,
        nextSitrepAt,
        lastAction: yield* lastManagerAction(manager),
      } satisfies ProjectManagerPresence;
    });

  /**
   * Open questions and the latest closed ones, oldest first, each with its task's name.
   * A card without a task carries the PM's name instead.
   */
  const listDecisionCards = (
    projectId: ProjectId,
    open: ReadonlyArray<ProjectAttentionItem>,
    pmName: string,
  ) =>
    Effect.gen(function* () {
      const closed = yield* repository.listRecentClosedAttentionItems({
        projectId,
        limit: CLOSED_DECISION_CARD_LIMIT,
      });
      const tasks = new Map(
        (yield* repository.listTasks({ projectId })).map((task) => [task.id, task]),
      );
      const items = [...closed, ...open].toSorted(
        (a, b) => isoMillis(a.createdAt) - isoMillis(b.createdAt),
      );
      return yield* Effect.forEach(items, (item) =>
        Effect.gen(function* () {
          if (item.taskId === null) {
            const card: ProjectDecisionCard = {
              item,
              taskNumber: null,
              taskTitle: pmName,
              plan: null,
            };
            return [card];
          }
          // The Director's cards may be about tasks in other projects.
          const task =
            tasks.get(item.taskId) ?? Option.getOrUndefined(yield* repository.getTask(item.taskId));
          if (task === undefined) return [];
          const card: ProjectDecisionCard = {
            item,
            taskNumber: task.number,
            taskTitle: task.title,
            plan: yield* approvalPlanFor(item),
          };
          return [card];
        }).pipe(
          // One unreadable row (say, a spec that no longer decodes) drops only its card,
          // not every project's summary and waiting items.
          Effect.catch((error) =>
            Effect.logWarning("could not read a decision card", {
              attentionId: item.id,
              taskId: item.taskId,
              error,
            }).pipe(Effect.as<ReadonlyArray<ProjectDecisionCard>>([])),
          ),
        ),
      ).pipe(Effect.map((cards) => cards.flat()));
    });

  /** A plan approval card shows the summary and todos of the spec version it asks about. */
  const approvalPlanFor = (item: ProjectAttentionItem) => {
    const specVersion = item.specVersion;
    const taskId = item.taskId;
    return item.kind !== "approval" || specVersion === null || taskId === null
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const version = yield* repository.getSpecVersion({
            taskId,
            version: specVersion,
          });
          if (Option.isNone(version)) return null;
          // The breakdown this one approval covers.
          const subtasks = (yield* repository.listChildTasks(taskId))
            .filter((child) => child.stage !== "cancelled")
            .map((child) => ({
              taskId: child.id,
              number: child.number,
              title: child.title,
              request: child.request,
              waitsOn: child.waitsOn,
            }));
          return approvalPlanOf(version.value.spec, subtasks);
        });
  };

  // Reading the PM transcript on every snapshot would be wasteful; the preview only
  // changes when a run settles or the user writes, which moves these shell fields.
  const lastMessageCache = new Map<
    ThreadId,
    { key: string; value: ProjectTeamAttentionSummary["lastMessage"] }
  >();
  const readManagerLastMessage = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null) return null;
      const key = [
        shell.latestRunId,
        shell.latestRunCompletedAt === undefined || shell.latestRunCompletedAt === null
          ? ""
          : DateTime.toEpochMillis(shell.latestRunCompletedAt),
        shell.latestUserMessageAt === null ? "" : DateTime.toEpochMillis(shell.latestUserMessageAt),
        shell.itemCount,
      ].join("|");
      const cached = lastMessageCache.get(threadId);
      if (cached !== undefined && cached.key === key) return cached.value;
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant", "user"],
      });
      const value = managerLastMessage(messages);
      lastMessageCache.set(threadId, { key, value });
      return value;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not read the PM chat's last message", { threadId, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  // A goal's checks change only when its spec gains a version, so the full spec is read
  // once per version; every other snapshot reads just the version numbers, one query a project.
  const checksCache = new Map<
    ProjectTaskId,
    { version: number; value: ReadonlyArray<ProjectTaskCheck> }
  >();
  const readTaskChecks = (taskId: ProjectTaskId, latestVersion: number | undefined) =>
    Effect.gen(function* () {
      if (latestVersion === undefined) return [];
      const cached = checksCache.get(taskId);
      if (cached !== undefined && cached.version === latestVersion) return cached.value;
      const version = yield* repository.getLatestSpecVersion(taskId);
      if (Option.isNone(version)) return [];
      const value = version.value.spec.criteria.map((criterion) => ({
        text: criterion.text,
        passed: criterion.evidence !== null && criterion.evidence.trim() !== "",
      }));
      checksCache.set(taskId, { version: version.value.version, value });
      return value;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not read the task's success criteria", { taskId, cause }).pipe(
          Effect.as<ReadonlyArray<ProjectTaskCheck>>([]),
        ),
      ),
    );

  const attentionSnapshot: ProjectTeamService["Service"]["attentionSnapshot"] = Effect.gen(
    function* () {
      yield* taskKeyLocks.withLock("prefixes", reconcileTaskKeyPrefixes);
      const managers = yield* repository.listManagers();
      const summaries = yield* Effect.forEach(managers, (manager) =>
        Effect.gen(function* () {
          const projectId = manager.projectId;
          const open = yield* repository.listOpenAttentionItems({ projectId });
          const latestItem = yield* repository.getLatestAttentionItem(projectId);
          const latestSitrep = yield* repository.getLatestSitrep(projectId);
          const latestPosted = yield* repository.getLatestPostedSitrep(projectId);
          // Questions waiting in threads outside the task board count as "Needs you" too.
          const waitingThreads = (yield* readOtherThreads({
            threads,
            repository,
            projectId,
            managerThreadId: manager.threadId,
            withRequestText: false,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not read the project's other threads", {
                projectId,
                cause,
              }).pipe(Effect.as([])),
            ),
          )).flatMap((thread) =>
            isWaitingOnUser(thread)
              ? [
                  {
                    threadId: thread.threadId,
                    title: thread.title,
                    kind: thread.pendingRequest.kind,
                  },
                ]
              : [],
          );
          const otherThreadsWaiting = waitingThreads.length;
          const presence = yield* managerPresence(manager, open, latestSitrep, otherThreadsWaiting);
          const decisionCards = yield* listDecisionCards(
            projectId,
            open,
            resolvePersona(projectId, manager.settings).name,
          );
          const tasks = yield* repository.listTasks({ projectId });
          const projectTaskIds = new Set(tasks.map((task) => task.id));
          // Top-level tasks are the goals: no parent, or a parent outside this project.
          const latestVersions = yield* repository.listLatestSpecVersionNumbers(projectId);
          // Cancelled goals never show on the map, so their specs aren't read.
          const checksByTask = new Map(
            yield* Effect.forEach(
              tasks.filter(
                (task) =>
                  task.stage !== "cancelled" &&
                  (task.parentTaskId === null || !projectTaskIds.has(task.parentTaskId)),
              ),
              (task) =>
                Effect.map(
                  readTaskChecks(task.id, latestVersions.get(task.id)),
                  (checks) => [task.id, checks] as const,
                ),
            ),
          );
          const memory = yield* repository.listMemory(projectId);
          const directionEntry = memory.find((entry) => entry.topic === PROJECT_DIRECTION_TOPIC);
          const briefingLine =
            memory
              .find((entry) => entry.topic === DIRECTOR_BRIEFING_TOPIC)
              ?.content.split("\n")
              .map((line) => line.trim())
              .find((line) => line !== "") ?? null;
          const afk = yield* activeAfk(manager.settings);
          const afkAnswers =
            afk === null
              ? []
              : (yield* repository.listProjectEventsSince({ projectId, since: afk.since }))
                  .filter((event) => event.kind === "afk_answer")
                  .slice(-MAX_AFK_ANSWERS_IN_SUMMARY)
                  .map((event) => ({
                    id: event.id,
                    at: event.createdAt,
                    threadId: event.actorThreadId,
                    taskId: event.taskId,
                    text: event.body,
                  }));
          return {
            projectId,
            pmThreadId: manager.threadId,
            ...(manager.kind === "director"
              ? { kind: "director" as const, briefing: briefingLine }
              : {}),
            openCount: open.length + otherThreadsWaiting,
            latestBatchId: Option.isSome(latestItem) ? latestItem.value.batchId : null,
            latestSitrepId: Option.isSome(latestPosted) ? latestPosted.value.id : null,
            unreadSitrepCount: yield* repository.countUnreadSitreps(projectId),
            sitrepInProgress: Option.isSome(latestSitrep) && latestSitrep.value.body === null,
            settings: manager.settings,
            persona: resolvePersona(projectId, manager.settings),
            enabled: manager.settings.enabled,
            presence,
            decisionCards,
            taskKeyPrefix: yield* taskKeyPrefixFor(projectId, manager.settings),
            taskKeyAliases: manager.settings.taskKeyAliases ?? [],
            lastMessage: yield* readManagerLastMessage(manager.threadId),
            afkAnswers,
            direction:
              directionEntry === undefined ? null : projectDirectionLine(directionEntry.content),
            waitingThreads,
            tasks: tasks.map((task) => ({
              id: task.id,
              number: task.number,
              parentTaskId: task.parentTaskId,
              waitsOn: task.waitsOn,
              title: task.title,
              stage: task.stage,
              leadThreadId: task.leadThreadId,
              location: task.location,
              moveTarget: task.moveTarget ?? null,
              memoryHold: task.memoryHold ?? null,
              prUrl: task.prUrl,
              lastOutcome: task.lastOutcome,
              openQuestion: open.some((item) => item.taskId === task.id),
              openBlocker: open.some((item) => item.taskId === task.id && item.kind === "blocker"),
              ready: task.ready !== null,
              updatedAt: task.updatedAt,
              iterateRound: task.iterateRound,
              shipRound: task.shipRound,
              modelSteps: task.modelSteps,
              checks: checksByTask.get(task.id) ?? null,
            })),
          } satisfies ProjectTeamAttentionSummary;
        }),
      );
      if (!summaries.some((summary) => summary.kind === "director")) return { projects: summaries };
      // The Director's summary carries the goals, aligned with every project's tasks.
      const goals = yield* repository.listWorkspaceGoals();
      // Same projects as team_status: the Director's own and every project not deleted.
      const projectIds: Array<ProjectId> = [];
      for (const summary of summaries) {
        const project = yield* projects.get(summary.projectId);
        if (
          summary.kind === "director" ||
          (Option.isSome(project) && project.value.deletedAt === null)
        ) {
          projectIds.push(summary.projectId);
        }
      }
      const goalAlignment = alignWorkspaceGoals({
        goals,
        projectIds,
        tasks: summaries.flatMap((summary) =>
          summary.tasks.map((task) => ({ ...task, projectId: summary.projectId })),
        ),
      });
      return {
        projects: summaries.map((summary) =>
          summary.kind === "director" ? { ...summary, goals, goalAlignment } : summary,
        ),
      };
    },
  ).pipe(orTeamError("Could not read the team attention summary."));

  const streamAttention: ProjectTeamService["Service"]["streamAttention"] = Stream.unwrap(
    Effect.map(router.subscribe, (subscription) =>
      Stream.concat(
        Stream.fromEffect(attentionSnapshot),
        // One snapshot per burst of changes, not one per change.
        Stream.fromSubscription(subscription).pipe(
          Stream.chunks,
          Stream.mapEffect(() => attentionSnapshot),
        ),
      ),
    ),
  );

  const recordOutcome: ProjectTeamService["Service"]["recordOutcome"] = (input) =>
    Effect.gen(function* () {
      const { task, outcome } = input;
      const failed = outcome === "failed";
      const updated = yield* setTask({
        id: task.id,
        lastOutcome: outcome,
        ...(failed ? { stage: "blocked" as const } : {}),
      });
      const event = yield* appendEvent(
        updated,
        "outcome",
        input.detail === undefined ? outcome : `${outcome}: ${input.detail}`,
        task.leadThreadId,
      );
      if (failed && task.stage !== "blocked") {
        yield* appendEvent(updated, "stage_changed", `${task.stage} → blocked`, null);
        yield* noteIdleMilestone(task.projectId, task.stage);
      }
      const open = failed
        ? yield* repository.listOpenAttentionItems({ projectId: task.projectId, taskId: task.id })
        : [];
      const events = failed
        ? yield* repository.listTaskEvents({ taskId: task.id, limit: Number.MAX_SAFE_INTEGER })
        : [];
      const retry = events.findLast(
        (event) => event.kind === "stage_changed" && event.body.startsWith("blocked → "),
      );
      // A retry's previous card can still be open while its answer is being relayed.
      const stale = (item: ProjectAttentionItem) =>
        isTurnFailedBlocker(item) &&
        retry !== undefined &&
        isoMillis(item.createdAt) < isoMillis(retry.createdAt);
      if (failed && !open.some((item) => isTurnFailedBlocker(item) && !stale(item))) {
        // Replace server escalations, but preserve questions the lead asked itself.
        for (const item of open) {
          const nudgeLimit =
            item.kind === "blocker" &&
            item.options.length === 0 &&
            item.question.startsWith(
              `#${task.number} ${task.title} made no progress after ${MAX_TASK_NUDGES} nudges. Last message:`,
            );
          if (stale(item) || nudgeLimit) {
            yield* repository.supersedeAttentionItem({
              id: item.id,
              supersededAt: yield* nowIso,
            });
          }
        }
        const reason = turnFailedReason(input.detail);
        yield* router.ask({
          task: updated,
          kind: "blocker",
          question: `#${task.number} ${task.title}: 리드 작업이 실패했어요${reason ? ` (${reason})` : ""}${input.detail ? `\n\n오류: ${input.detail}` : ""}\n\n다시 시도하면 리드가 멈춘 곳부터 이어서 해요. 리드에게 전할 말이 있으면 함께 적어 주세요.`,
          options: [...TURN_FAILED_OPTIONS],
          askerThreadId: task.leadThreadId,
        });
      }
      yield* router.publish(task.projectId);
      return { task: updated, event };
    }).pipe(orTeamError("Could not record the task outcome.", input.task.projectId));

  const raisePermissionBlocker: ProjectTeamService["Service"]["raisePermissionBlocker"] = (input) =>
    Effect.gen(function* () {
      const task = yield* repository.findTaskByLeadThreadId(input.threadId);
      if (Option.isSome(task)) {
        const current = task.value;
        if (!LIVE_TASK_STAGES.has(current.stage)) return Option.none();
        const open = yield* repository.listOpenAttentionItems({
          projectId: current.projectId,
          taskId: current.id,
        });
        if (open.length > 0) return Option.none();
        const card = permissionBlockerCard({
          who: `${yield* keyOf(current)} ${current.title}`,
          denial: input.denial,
        });
        const item = yield* router.ask({
          task: current,
          kind: "blocker",
          ...card,
          askerThreadId: input.threadId,
        });
        yield* appendEvent(current, "note", "Raised a blocker for a permission denial.", null);
        return Option.some(item);
      }
      const manager = yield* repository.getManagerByThreadId(input.threadId);
      if (
        Option.isNone(manager) ||
        manager.value.kind === "director" ||
        !manager.value.settings.enabled
      ) {
        return Option.none();
      }
      const projectId = manager.value.projectId;
      const open = yield* repository.listOpenAttentionItems({ projectId });
      if (open.some((item) => item.askerThreadId === input.threadId)) return Option.none();
      const card = permissionBlockerCard({
        who: resolvePersona(projectId, manager.value.settings).name,
        denial: input.denial,
      });
      const item = yield* router.ask({
        task: null,
        projectId,
        kind: "blocker",
        ...card,
        askerThreadId: input.threadId,
      });
      return Option.some(item);
    }).pipe(orTeamError("Could not raise the permission blocker."));

  const modelSessionOf: ProjectTeamService["Service"]["modelSessionOf"] = (threadId) =>
    repository
      .findModelRunByThreadId(threadId)
      .pipe(Effect.map(Option.getOrNull), orTeamError("Could not read the model session."));

  const recordRunUsage: ProjectTeamService["Service"]["recordRunUsage"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* repository.addModelRunUsage(input);
      if (Option.isSome(updated)) yield* router.publish(updated.value.projectId);
    }).pipe(orTeamError("Could not record the step's usage."));

  const recordShipWake: ProjectTeamService["Service"]["recordShipWake"] = (input) =>
    Effect.gen(function* () {
      const task = yield* repository.findTaskByLeadThreadId(input.leadThreadId);
      if (Option.isNone(task) || task.value.stage !== "in_review") return Option.none();
      const shipped = yield* repository.reopenShipRound({ id: task.value.id, now: yield* nowIso });
      if (Option.isNone(shipped)) return Option.none();
      const reopened =
        input.checksFailed === true
          ? Option.orElse(
              yield* repository.bumpTaskMetric({
                id: task.value.id,
                metric: "ciFailures",
                by: 1,
              }),
              () => shipped,
            )
          : shipped;
      if (Option.isNone(reopened)) return Option.none();
      yield* appendEvent(
        reopened.value,
        "note",
        `Ship round ${reopened.value.shipRound}: ${clip(input.summary, 200)}`,
        null,
      );
      yield* router.publish(reopened.value.projectId);
      return reopened;
    }).pipe(orTeamError("Could not record the pull request update."));

  yield* taskKeyLocks.withLock("prefixes", reconcileTaskKeyPrefixes);

  yield* recoverInterruptedMoves;

  return {
    ensureManager,
    roleOf,
    createTask,
    startTask,
    updateTask,
    readSpec,
    writeSpec,
    setTodo,
    setEvidence,
    setReview,
    markTaskReady,
    nudgeTask,
    listTasks,
    readTask,
    searchTasks,
    teamStatus,
    updateSettingsAsManager,
    updateSettings,
    askUser,
    getTaskDetail,
    updateTaskSpec,
    restoreTaskSpec,
    splitTaskTodo,
    setTaskRoleModels,
    moveTask,
    delegateStep,
    answerDecision,
    askLead,
    answerAttention,
    dismissAttention,
    listMemory,
    writeMemory,
    deleteMemory,
    goalWrite,
    goalLink,
    pmNudge,
    goalAlignmentReport,
    requestSitrep,
    attentionSnapshot,
    afkSweep,
    streamAttention,
    recordOutcome,
    raisePermissionBlocker,
    recordShipWake,
    modelSessionOf,
    recordRunUsage,
  } satisfies ProjectTeamService["Service"];
});

export const layer = Layer.effect(ProjectTeamService, make);

/** The service with its router and sitrep scheduler. */
export const layerWithDependencies = layer.pipe(
  Layer.provideMerge(FinishedTaskCleanup.layer),
  Layer.provideMerge(SitrepScheduler.layer),
  Layer.provideMerge(AttentionRouter.layer),
);

/** Answers questions for an AFK user a little after their grace period ends. */
export const layerAfkWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const team = yield* ProjectTeamService;
    const scheduler = yield* Scheduler.Scheduler;
    const every10Seconds = yield* makePeriodicGate(10_000);
    yield* scheduler.register("project-team-afk-sweep", every10Seconds(team.afkSweep));
  }),
);
