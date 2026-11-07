import {
  type ChatAttachment,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROJECT_TEAM_SETTINGS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
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
  type ProjectManagerLastAction,
  type ProjectManagerPersona,
  type ProjectManagerPresence,
  type ProjectManagerVoice,
  ProjectMemoryEntryId,
  type ProjectTask,
  type ProjectTaskBrief,
  ProjectTaskStatus,
  type ProjectTaskStatusSignals,
  resolveProjectTaskStatus,
  storedTaskStatusSignals,
  type ProjectTaskEvent,
  ProjectTaskEventId,
  type ProjectTaskEventKind,
  ProjectTaskId,
  type ProjectTaskOutcome,
  type ServerProvider,
  isProviderAvailable,
  type ProjectTaskStage,
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
  type ProjectTeamCreateTaskInput,
  type ProjectTeamRestoreTaskSpecInput,
  type ProjectTeamSplitTaskTodoInput,
  type ProjectTeamSplitTaskTodoResult,
  type ProjectTeamTaskDetail,
  type ProjectTeamTaskRefInput,
  type ProjectTeamUpdateTaskSpecInput,
  type ProjectTaskSpec,
  type ProjectTeamTaskSpecReadInput,
  type ProjectTeamTaskSpecResult,
  type ProjectTeamTaskSpecWriteInput,
  type ProjectTeamTaskTodoSetInput,
  defaultTaskKeyPrefix,
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
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  type AttachmentClaimError,
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../orchestration-v2/AttachmentClaims.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectTeamRepositoryError } from "../persistence/Errors.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import { directorWorkspaceRoot, epicStage } from "./director.ts";
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
  resolvePersona,
  voiceText,
} from "./persona.ts";
import * as FinishedTaskCleanup from "./FinishedTaskCleanup.ts";
import { managerLastMessage } from "./managerLastMessage.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import { buildTaskLeadPrompt, nextStepHint } from "./taskLeadPrompt.ts";

export const MAX_TASK_NUDGES = 2;
const DEFAULT_TASK_EVENT_LIMIT = 20;
/** Stages the PM presence counts; done and cancelled tasks never show. */
/** A task waiting on another may start once that one is in review or done. */
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

/** Wakes the PM when the user adds a task and asks for a plan. */
export function planRequestedWakeText(
  key: string,
  task: Pick<ProjectTask, "id" | "title">,
): string {
  return [
    `[Task added by the user] ${key} ${task.title}`,
    `The user wants a plan for it. Start it with task_start (taskId: ${task.id}) when a slot is free, and tell the user if it has to wait.`,
  ].join("\n");
}

/** Wakes a project's PM when the Director routes a task to it. */
export function directorAddedTaskWakeText(
  key: string,
  task: Pick<ProjectTask, "id" | "title">,
): string {
  return [
    `[Director added task] ${key} ${task.title}`,
    `The Director put it in your inbox on the user's behalf. Treat it as the user's request: start it with task_start (taskId: ${task.id}) when a slot is free, and tell the user in one line if it has to wait.`,
  ].join("\n");
}

/** The spec background for a user-created task: their context, then the files they attached. */
export function userTaskBackground(
  context: string,
  attachments: ReadonlyArray<{
    readonly name: string;
    readonly mimeType: string;
    readonly path: string;
  }>,
): string {
  if (attachments.length === 0) return context;
  const list = [
    "Attachments (read these files):",
    ...attachments.map((file) => `- ${file.name} (${file.mimeType}): ${file.path}`),
  ].join("\n");
  return context.length > 0 ? `${context}\n\n${list}` : list;
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
    const task = taskId === null ? undefined : taskById.get(taskId);
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
    status: resolveProjectTaskStatus(task, signals),
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

    readonly createTask: (
      callerThreadId: ThreadId,
      input: ProjectTeamTaskCreateInput,
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

    /** projectTeam.createTask RPC: the user adds a task; startPlanning asks the PM to start it. */
    readonly createTaskForUser: (
      input: ProjectTeamCreateTaskInput,
    ) => Effect.Effect<ProjectTeamTaskDetail, ProjectTeamError>;
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

    /** projectTeam.answerDecision RPC: the user answered a card; goes straight to the lead. */
    readonly answerDecision: (
      input: ProjectTeamAnswerDecisionInput,
    ) => Effect.Effect<ProjectTeamAttentionItemResult, ProjectTeamError>;

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

    /** projectTeam.requestSitrep RPC. */
    readonly requestSitrep: (
      input: ProjectTeamRequestSitrepInput,
    ) => Effect.Effect<ProjectTeamRequestSitrepResult, ProjectTeamError>;
    readonly attentionSnapshot: Effect.Effect<ProjectTeamAttentionSnapshot, ProjectTeamError>;
    /** One pass over every project: answers what waited past the grace period while AFK is on. */
    readonly afkSweep: Effect.Effect<void>;
    /** The current snapshot, then a fresh one after every change. */
    readonly streamAttention: Stream.Stream<ProjectTeamAttentionSnapshot, ProjectTeamError>;

    /** Records how a task lead's turn ended; failed blocks the task and raises a blocker. */
    readonly recordOutcome: (input: {
      readonly task: ProjectTask;
      readonly outcome: ProjectTaskOutcome;
      readonly detail?: string;
    }) => Effect.Effect<
      { readonly task: ProjectTask; readonly event: ProjectTaskEvent },
      ProjectTeamError
    >;
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
  const fileSystem = yield* FileSystem.FileSystem;

  /** Copies the user's pending uploads under the task so the pending sweep keeps them. */
  const claimTaskAttachments = (
    taskId: ProjectTaskId,
    projectId: ProjectId,
    attachments: ReadonlyArray<ChatAttachment>,
  ) =>
    claimPendingAttachments({ threadId: taskId, attachments }).pipe(
      Effect.flatMap((claimed) =>
        Effect.forEach(claimed.attachments, (attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          return path === null
            ? Effect.fail(
                teamError(`Attachment '${attachment.name}' has no stored file.`, projectId),
              )
            : Effect.succeed({ name: attachment.name, mimeType: attachment.mimeType, path });
        }).pipe(Effect.onError(() => releaseClaimedAttachments(claimed.claimedPaths))),
      ),
      Effect.catchTag("AttachmentClaimError", (error: AttachmentClaimError) =>
        Effect.fail(teamError(error.message, projectId)),
      ),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

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
  const taskStartLocks = yield* KeyedLock.make<ProjectId>();
  const specLocks = yield* KeyedLock.make<ProjectTaskId>();

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
          onSome: Effect.succeed,
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

  const setTask = (input: Omit<ProjectTeamRepository.UpdateProjectTaskInput, "now">) =>
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
      // A finished task's questions can no longer be answered, so close them.
      if (FinishedTaskCleanup.isFinishedStage(updated.value.stage)) {
        yield* repository.supersedeOpenAttentionItems({
          taskId: updated.value.id,
          supersededAt: now,
        });
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
    managerLocks.withLock(
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
    );

  const createTask: ProjectTeamService["Service"]["createTask"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "director"], "task_create");
      const projectId = yield* taskCreateProject(role, input.projectId);
      const waitsOn = (yield* checkWaitsOn(null, input.waitsOn ?? [], projectId)).map(
        (task) => task.id,
      );
      if (input.parentTaskId !== undefined) {
        yield* checkParent(null, input.parentTaskId, projectId);
      }
      const task = yield* repository.createTask({
        id: ProjectTaskId.make(yield* newId("task")),
        projectId,
        title: input.title,
        request: input.request,
        waitsOn,
        parentTaskId: input.parentTaskId,
        now: yield* nowIso,
        author: "pm",
        authorThreadId: callerThreadId,
      });
      yield* appendEvent(task, "created", task.title, callerThreadId);
      if (task.parentTaskId !== null) yield* syncEpic(task.parentTaskId);
      if (projectId !== role.projectId) {
        const manager = yield* requireManager(projectId);
        const key = formatTaskKey(
          yield* taskKeyPrefixFor(projectId, manager.settings),
          task.number,
        );
        yield* wakeManagerWith(
          projectId,
          `project-team:director-added:${task.id}`,
          directorAddedTaskWakeText(key, task),
        );
        yield* router.publish(role.projectId);
      }
      yield* router.publish(projectId);
      return { task };
    }).pipe(orTeamError("Could not create the task."));

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
          const limit = manager.settings.maxConcurrentTasks;
          if (active.length >= limit) {
            return yield* teamError(
              `#${task.number} stays in the inbox: ${active.length} of ${limit} task leads are already running.`,
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
          const memory = yield* repository.listMemory(role.projectId);
          const key = formatTaskKey(
            yield* taskKeyPrefixFor(role.projectId, manager.settings),
            task.number,
          );
          const spec = yield* latestSpec(task);
          // A task whose plan was already approved resumes straight into the work.
          const resume = task.planSummary !== null;
          // A restart must not reuse the first lead's request id, or it gets that lead back.
          const earlierSessions = (yield* repository.listTaskSessions(task.id)).length;
          const lead = yield* delegate({
            task: buildTaskLeadPrompt({
              task,
              key,
              spec,
              resume,
              memory,
              otherTasks: active,
              ...((yield* activeAfk(manager.settings)) === null ? {} : { afkRule: AFK_AGENT_RULE }),
            }),
            title: `${key} ${task.title}`,
            role: "implementation",
            isolation: "worktree",
            mode: "async",
            clientRequestId:
              earlierSessions === 0
                ? `task-start:${task.id}`
                : `task-start:${task.id}:${earlierSessions + 1}`,
            ...(input.target === undefined ? {} : { target: input.target }),
          }).pipe(
            Effect.mapError((failure) =>
              teamError(
                `Could not start a task lead for #${task.number}: ${failure.message}`,
                role.projectId,
              ),
            ),
          );
          const started = yield* setTask({
            id: task.id,
            stage: "planning",
            leadThreadId: lead.childThreadId,
          });
          yield* repository.addTaskSession({
            taskId: started.id,
            threadId: lead.childThreadId,
            role: resume ? "implementer" : "lead",
            createdAt: started.stageChangedAt,
          });
          yield* appendEvent(started, "stage_changed", "inbox → planning", callerThreadId);
          yield* router.publish(role.projectId);
          return { task: started, leadThreadId: lead.childThreadId };
        }),
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

  /** Writes the next version from the latest one; a lead's write is an agent's. */
  const appendAgentSpec = (
    callerThreadId: ThreadId,
    task: ProjectTask,
    author: "pm" | "lead",
    note: string,
    next: (latest: ProjectTaskSpec) => Effect.Effect<ProjectTaskSpec, ProjectTeamError>,
    baseVersion?: number,
  ) =>
    specLocks.withLock(
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
    );

  const readSpec: ProjectTeamService["Service"]["readSpec"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const { task } = yield* specTaskFor(callerThreadId, input.taskId, "task_spec_read", "read");
      return yield* specResult(task, yield* latestSpec(task));
    }).pipe(orTeamError("Could not read the spec."));

  const writeSpec: ProjectTeamService["Service"]["writeSpec"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const { task, author } = yield* specTaskFor(callerThreadId, input.taskId, "task_spec_write");
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
      );
      yield* router.publish(task.projectId);
      return yield* specResult(task, version);
    }).pipe(orTeamError("Could not update the todo."));

  const updateTask: ProjectTeamService["Service"]["updateTask"] = (callerThreadId, input) =>
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
      const dependencies =
        input.waitsOn === undefined
          ? undefined
          : yield* checkWaitsOn(task.id, input.waitsOn, role.projectId);
      const parent =
        input.parentTaskId === undefined || input.parentTaskId === null
          ? input.parentTaskId
          : yield* checkParent(task.id, input.parentTaskId, role.projectId);
      const updated = yield* setTask({
        id: task.id,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(dependencies === undefined ? {} : { waitsOn: dependencies.map((dep) => dep.id) }),
        ...(parent === undefined ? {} : { parentTaskId: parent === null ? null : parent.id }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.planSummary === undefined ? {} : { planSummary: input.planSummary }),
        ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
        ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
      });
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
      if (stageChanged && FinishedTaskCleanup.isFinishedStage(updated.stage)) {
        // A PM cancel stops the lead now; otherwise the lead's turn ends first.
        yield* finishedTasks.archiveLead(updated, {
          stopLead: role.type === "pm" && updated.stage === "cancelled",
        });
      } else if (stageChanged && FinishedTaskCleanup.isFinishedStage(task.stage)) {
        // Reopened, like moving a Linear issue out of Done: the lead and worktree return.
        yield* finishedTasks.reviveLead(updated);
      }
      yield* router.publish(role.projectId);
      return { task: updated };
    }).pipe(orTeamError("Could not update the task."));

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
      if (task.nudgeCount >= MAX_TASK_NUDGES) {
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
      const nudged = yield* setTask({ id: task.id, nudgeCount: task.nudgeCount + 1 });
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
        ...(role.type === "director" ? { workspace: yield* workspaceView(tasks) } : {}),
      } satisfies ProjectTeamStatus;
    }).pipe(orTeamError("Could not read the team status."));

  /**
   * The Director's view of the workspace: each project's counts, open tasks and
   * questions, and its PM's summary; then each open epic with its subtasks.
   */
  const workspaceView = (epics: ReadonlyArray<ProjectTask>) =>
    Effect.gen(function* () {
      const managers = (yield* repository.listManagers()).filter(
        (manager) => manager.kind === "pm",
      );
      const briefById = new Map<string, ProjectTaskBrief>();
      const prefixByProject = new Map<string, string>();
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
      return { projects: projectsView, epics: epicsView } satisfies ProjectTeamWorkspace;
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
      /** User-only; updateSettingsAsManager never passes it. */
      readonly afk?: { readonly hours: number | null } | null | undefined;
    },
    actorThreadId: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      const { persona: personaPatch, ...plain } = patch;
      if (
        Object.values(plain).every((value) => value === undefined) &&
        !hasPersonaChange(personaPatch)
      ) {
        return yield* teamError("The settings update has no fields.", projectId);
      }
      const { manager, settings, now, previousPersona, persona } = yield* sitreps.withSettingsLock(
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
          const afk =
            patch.afk === undefined
              ? afkSetting(manager.settings)
              : patch.afk === null
                ? undefined
                : {
                    since: now,
                    until:
                      patch.afk.hours === null
                        ? null
                        : DateTime.formatIso(
                            DateTime.add(DateTime.makeUnsafe(now), { hours: patch.afk.hours }),
                          ),
                  };
          const quietHours =
            patch.quietHours === undefined
              ? manager.settings.quietHours
              : (patch.quietHours ?? undefined);
          const settings: ProjectTeamSettings = {
            ...current,
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
            ...(patch.taskKeyPrefix === undefined ? {} : { taskKeyPrefix: patch.taskKeyPrefix }),
            ...(afk === undefined ? {} : { afk }),
            // Only setting the interval by hand stops it adapting, for good; other fields
            // keep the pin as is.
            ...(patch.sitrepIntervalMinutes === undefined ? {} : { intervalPinnedAt: now }),
          };
          yield* repository.updateManagerSettings({ projectId, settings, now });
          return { manager, settings, now, previousPersona, persona };
        }),
      );
      if (persona.name !== previousPersona.name) {
        yield* renameManagerThread(manager.threadId, persona.name);
      }
      // The system prompt only refreshes when the PM's session reopens, so a user's change
      // reaches the live PM as a message. A PM that changed itself already knows.
      const personaNews =
        actorThreadId === null ? personaChangeText(previousPersona, persona) : null;
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
      if (patch.afk !== undefined) {
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
    }).pipe(orTeamError("Could not update the team settings.", projectId));

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
          },
          callerThreadId,
        ),
      ),
    );

  const updateSettings: ProjectTeamService["Service"]["updateSettings"] = ({
    projectId,
    ...patch
  }) => applySettings(projectId, patch, null);

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
      if (input.goal === undefined || input.verification === undefined) {
        return yield* teamError(
          "ask_user(kind: approval) needs goal and verification: 2-4 short markdown bullets each, shown on the card so the user can approve without opening the plan. goal: what changes and the end result (note risky steps or scope cuts). verification: how we'll know it's done (tests, checks, screenshots).",
        );
      }
      const spec = yield* latestSpec(task);
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
        // One way to approve: approving always starts the work.
        options: [PLAN_APPROVAL_START],
        askerThreadId: callerThreadId,
        specVersion: spec.version,
        summary: input.goal,
        verification: input.verification,
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
      if (item.kind !== "approval" || item.answer === null) return;
      const task = yield* requireTask(item.taskId, item.projectId);
      if (task.stage !== "awaiting_approval") return;
      const outcome = planApprovalOutcome(item.answer);
      yield* moveTaskStage(
        task,
        outcome === "start" ? "running" : outcome === "approve_only" ? "inbox" : "planning",
        actorThreadId,
      );
    });

  const askUser: ProjectTeamService["Service"]["askUser"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["lead"], "ask_user");
      const task = yield* requireTask(role.taskId, role.projectId);
      if (input.kind === "approval") return yield* askPlanApproval(callerThreadId, task, input);
      const item = yield* router.ask({
        task,
        kind: input.kind,
        question: input.question,
        options: input.options ?? [],
        askerThreadId: callerThreadId,
      });
      // The question shows on the task's page and above the PM composer; the PM is not woken.
      yield* appendEvent(task, "note", `Asked the user (${input.kind}).`, callerThreadId);
      return { item };
    }).pipe(orTeamError("Could not ask the user."));

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
      const answered = yield* router.answer({
        item: item.value,
        answer: input.answer,
        senderThreadId: callerThreadId,
        answeredBy: "pm",
      });
      yield* afterPlanApprovalAnswer(answered, callerThreadId);
      return { item: answered };
    }).pipe(orTeamError("Could not answer the question."));

  const dismissAttention: ProjectTeamService["Service"]["dismissAttention"] = (
    callerThreadId,
    input,
  ) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "attention_dismiss");
      const item = yield* repository.getAttentionItem(input.attentionItemId);
      if (Option.isNone(item) || item.value.projectId !== role.projectId) {
        return yield* teamError(
          `Attention item ${input.attentionItemId} was not found in this project.`,
          role.projectId,
        );
      }
      if (role.type === "lead" && item.value.askerThreadId !== callerThreadId) {
        return yield* teamError(
          "A task lead can only close its own questions. Ask the PM if another question is moot.",
          role.projectId,
        );
      }
      const dismissed = yield* router.dismiss({
        item: item.value,
        reason: input.reason,
        senderThreadId: callerThreadId,
        notifyAsker: role.type === "pm",
      });
      yield* appendEvent(
        { id: dismissed.taskId, projectId: dismissed.projectId },
        "note",
        `Question closed: ${input.reason}`,
        callerThreadId,
      );
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
      return version;
    });

  const createTaskForUser: ProjectTeamService["Service"]["createTaskForUser"] = (input) =>
    Effect.gen(function* () {
      yield* requireManager(input.projectId);
      if (input.parentTaskId !== undefined) {
        yield* requireTask(input.parentTaskId, input.projectId);
      }
      const context = input.context.trim();
      const taskId = ProjectTaskId.make(yield* newId("task"));
      const attachments =
        input.attachments === undefined || input.attachments.length === 0
          ? []
          : yield* claimTaskAttachments(taskId, input.projectId, input.attachments);
      const task = yield* repository.createTask({
        id: taskId,
        projectId: input.projectId,
        title: input.title,
        request: context.length > 0 ? context : input.title,
        waitsOn: [],
        parentTaskId: input.parentTaskId,
        spec: {
          background: userTaskBackground(context, attachments),
          goal: "",
          successCriteria: "",
          nonGoals: "",
          todos: [],
        },
        now: yield* nowIso,
        author: "user",
        authorThreadId: null,
      });
      yield* appendEvent(task, "created", task.title, null);
      const detail = yield* taskDetail(task);
      if (input.startPlanning) {
        yield* wakeManagerWith(
          task.projectId,
          `project-team:plan-requested:${task.id}`,
          planRequestedWakeText(detail.key, task),
        );
      }
      yield* router.publish(task.projectId);
      return detail;
    }).pipe(orTeamError("Could not create the task.", input.projectId));

  const getTaskDetail: ProjectTeamService["Service"]["getTaskDetail"] = (input) =>
    requireTask(input.taskId, input.projectId).pipe(
      Effect.flatMap(taskDetail),
      orTeamError("Could not read the task.", input.projectId),
    );

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
            spec: { background: todo.text, goal: "", successCriteria: "", nonGoals: "", todos: [] },
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
      const answered = yield* router.answer({
        item: item.value,
        answer: input.answer,
        senderThreadId: manager.threadId,
        answeredBy: "user",
      });
      const task = yield* requireTask(answered.taskId, answered.projectId);
      yield* appendEvent(task, "note", `The user answered (${answered.kind}).`, null);
      yield* afterPlanApprovalAnswer(answered, null);
      return { item: answered };
    }).pipe(orTeamError("Could not answer the question.", input.projectId));

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
      const entry = yield* repository.upsertMemory({
        id: ProjectMemoryEntryId.make(yield* newId("memory")),
        projectId: role.projectId,
        topic: input.topic,
        content: input.content,
        updatedAt: yield* nowIso,
      });
      return { entry };
    }).pipe(orTeamError("Could not write the project memory."));

  const deleteMemory: ProjectTeamService["Service"]["deleteMemory"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "director"], "memory_delete");
      const deleted = yield* repository.deleteMemory({
        projectId: role.projectId,
        topic: input.topic,
      });
      return { topic: input.topic, deleted };
    }).pipe(orTeamError("Could not delete the project memory."));

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

  /** Open questions and the latest closed ones, oldest first, each with its task's name. */
  const listDecisionCards = (projectId: ProjectId, open: ReadonlyArray<ProjectAttentionItem>) =>
    Effect.gen(function* () {
      const closed = yield* repository.listRecentClosedAttentionItems({
        projectId,
        limit: CLOSED_DECISION_CARD_LIMIT,
      });
      const tasks = new Map(
        (yield* repository.listTasks({ projectId })).map((task) => [task.id, task]),
      );
      return [...closed, ...open]
        .toSorted((a, b) => isoMillis(a.createdAt) - isoMillis(b.createdAt))
        .flatMap((item): ReadonlyArray<ProjectDecisionCard> => {
          const task = tasks.get(item.taskId);
          return task === undefined
            ? []
            : [{ item, taskNumber: task.number, taskTitle: task.title }];
        });
    });

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

  const attentionSnapshot: ProjectTeamService["Service"]["attentionSnapshot"] = Effect.gen(
    function* () {
      const managers = yield* repository.listManagers();
      const summaries = yield* Effect.forEach(managers, (manager) =>
        Effect.gen(function* () {
          const projectId = manager.projectId;
          const open = yield* repository.listOpenAttentionItems({ projectId });
          const latestItem = yield* repository.getLatestAttentionItem(projectId);
          const latestSitrep = yield* repository.getLatestSitrep(projectId);
          const latestPosted = yield* repository.getLatestPostedSitrep(projectId);
          // Questions waiting in threads outside the task board count as "Needs you" too.
          const otherThreadsWaiting = (yield* readOtherThreads({
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
          )).filter(isWaitingOnUser).length;
          const presence = yield* managerPresence(manager, open, latestSitrep, otherThreadsWaiting);
          const decisionCards = yield* listDecisionCards(projectId, open);
          const tasks = yield* repository.listTasks({ projectId });
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
            ...(manager.kind === "director" ? { kind: "director" as const } : {}),
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
            lastMessage: yield* readManagerLastMessage(manager.threadId),
            afkAnswers,
            tasks: tasks.map((task) => ({
              id: task.id,
              number: task.number,
              parentTaskId: task.parentTaskId,
              title: task.title,
              stage: task.stage,
              leadThreadId: task.leadThreadId,
              prUrl: task.prUrl,
              lastOutcome: task.lastOutcome,
              openQuestion: open.some((item) => item.taskId === task.id),
              openBlocker: open.some((item) => item.taskId === task.id && item.kind === "blocker"),
              updatedAt: task.updatedAt,
            })),
          } satisfies ProjectTeamAttentionSummary;
        }),
      );
      return { projects: summaries };
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
        yield* router.ask({
          task: updated,
          kind: "blocker",
          question: `#${task.number} ${task.title}: the task lead's turn failed${input.detail === undefined ? "" : ` (${input.detail})`}. Decide whether to retry, change the plan, or cancel the task.`,
          options: [],
          askerThreadId: task.leadThreadId,
        });
        yield* noteIdleMilestone(task.projectId, task.stage);
      }
      yield* router.publish(task.projectId);
      return { task: updated, event };
    }).pipe(orTeamError("Could not record the task outcome.", input.task.projectId));

  return {
    ensureManager,
    roleOf,
    createTask,
    startTask,
    updateTask,
    readSpec,
    writeSpec,
    setTodo,
    nudgeTask,
    listTasks,
    readTask,
    searchTasks,
    teamStatus,
    updateSettingsAsManager,
    updateSettings,
    askUser,
    createTaskForUser,
    getTaskDetail,
    updateTaskSpec,
    restoreTaskSpec,
    splitTaskTodo,
    answerDecision,
    answerAttention,
    dismissAttention,
    listMemory,
    writeMemory,
    deleteMemory,
    requestSitrep,
    attentionSnapshot,
    afkSweep,
    streamAttention,
    recordOutcome,
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
