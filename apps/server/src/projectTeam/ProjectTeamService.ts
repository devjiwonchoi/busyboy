import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROJECT_TEAM_SETTINGS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type IsoDateTime,
  MessageId,
  type ModelSelection,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpFailure,
  type ProjectAttentionItem,
  type ProjectDecisionCard,
  type ProjectSitrep,
  type ProjectId,
  type ProjectManagerAvatar,
  type ProjectManagerLastAction,
  type ProjectManagerPersona,
  type ProjectManagerPresence,
  type ProjectManagerVoice,
  ProjectMemoryEntryId,
  type ProjectTask,
  type ProjectTaskBrief,
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
  PLAN_APPROVAL_ONLY,
  PLAN_APPROVAL_START,
  defaultTaskKeyPrefix,
  formatTaskKey,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectTeamRepositoryError } from "../persistence/Errors.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import { isWaitingOnUser, readOtherThreads } from "./otherThreads.ts";
import {
  MINUTE_MS,
  isoFromMillis,
  isoMillis,
  makeIdGenerator,
  nowIso,
  orTeamError,
  teamError,
} from "./common.ts";
import { isUserWordsVoice, resolvePersona, voiceText } from "./persona.ts";
import * as FinishedTaskCleanup from "./FinishedTaskCleanup.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import { buildTaskLeadPrompt, nextStepHint } from "./taskLeadPrompt.ts";

export const MAX_TASK_NUDGES = 2;
const DEFAULT_TASK_EVENT_LIMIT = 20;
/** Stages the PM presence counts; done and cancelled tasks never show. */
const PRESENCE_TASK_STAGES: ReadonlyArray<ProjectTaskStage> = [
  "inbox",
  "planning",
  "running",
  "in_review",
];
const DEFAULT_TASK_SEARCH_LIMIT = 20;
const LEAD_MESSAGE_SUMMARY_MAX_CHARS = 300;
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

const trimJournalText = (text: string): string =>
  text.length <= JOURNAL_TEXT_MAX_CHARS ? text : `${text.slice(0, JOURNAL_TEXT_MAX_CHARS - 1)}…`;

/**
 * The team's recent history for team_status, newest first: tasks that finished or
 * failed, the user's answered questions, and posted sitreps.
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
    if (event.kind === "outcome") {
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
    if (Option.isSome(manager)) return { type: "pm", projectId: manager.value.projectId };
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

export function toTaskBrief(task: ProjectTask): ProjectTaskBrief {
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
  };
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
      return "changed the sitrep interval";
  }
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
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const router = yield* AttentionRouter.AttentionRouter;
  const sitreps = yield* SitrepScheduler.SitrepScheduler;
  const finishedTasks = yield* FinishedTaskCleanup.FinishedTaskCleanup;
  const newId = yield* makeIdGenerator;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  // At boot the provider cache may still be empty, so probe once before giving up.
  const availableModelSelection = Effect.gen(function* () {
    const cached = pickManagerModelSelection(yield* providerRegistry.getProviders);
    if (cached !== null) return cached;
    const refreshed = yield* providerRegistry.refresh().pipe(Effect.timeoutOption("15 seconds"));
    return Option.isSome(refreshed) ? pickManagerModelSelection(refreshed.value) : null;
  });
  const managerLocks = yield* KeyedLock.make<ProjectId>();
  const taskStartLocks = yield* KeyedLock.make<ProjectId>();
  const specLocks = yield* KeyedLock.make<ProjectTaskId>();

  const roleOf: ProjectTeamService["Service"]["roleOf"] = (threadId) =>
    roleOfThread(threadId).pipe(
      Effect.provideService(ProjectTeamRepository.ProjectTeamRepository, repository),
      orTeamError("Could not read the thread's team role."),
    );

  const requireRole = <T extends "pm" | "lead">(
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
      const updated = yield* repository.updateTask({ ...input, now });
      if (Option.isNone(updated)) return yield* teamError(`Task ${input.id} was not found.`);
      // A finished task's questions can no longer be answered, so close them.
      if (FinishedTaskCleanup.isFinishedStage(updated.value.stage)) {
        yield* repository.supersedeOpenAttentionItems({
          taskId: updated.value.id,
          supersededAt: now,
        });
      }
      return updated.value;
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
        const existing = yield* repository.getManager(projectId);
        if (Option.isSome(existing)) {
          const shell = yield* threads.getThreadShell(existing.value.threadId);
          if (shell !== null && shell.deletedAt === null) {
            return yield* reviveManager(existing.value, shell, project.value.title);
          }
        }
        const persona = resolvePersona(
          projectId,
          Option.isSome(existing) ? existing.value.settings : DEFAULT_PROJECT_TEAM_SETTINGS,
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
            const kept = Option.isSome(stored)
              ? stored.value.settings
              : DEFAULT_PROJECT_TEAM_SETTINGS;
            return yield* repository.upsertManager({
              projectId,
              threadId,
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
      const role = yield* requireRole(callerThreadId, ["pm"], "task_create");
      const waitsOn = input.waitsOn ?? [];
      yield* Effect.forEach(waitsOn, (taskId) => requireTask(taskId, role.projectId), {
        discard: true,
      });
      const task = yield* repository.createTask({
        id: ProjectTaskId.make(yield* newId("task")),
        projectId: role.projectId,
        title: input.title,
        request: input.request,
        waitsOn,
        now: yield* nowIso,
        author: "pm",
        authorThreadId: callerThreadId,
      });
      yield* appendEvent(task, "created", task.title, callerThreadId);
      yield* router.publish(role.projectId);
      return { task };
    }).pipe(orTeamError("Could not create the task."));

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
            const dependency = yield* requireTask(dependencyId, role.projectId);
            if (dependency.stage !== "done" && dependency.stage !== "in_review") {
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
          // A task parked after its plan was approved resumes straight into the work.
          const approved = task.planSummary !== null;
          // A restart must not reuse the first lead's request id, or it gets that lead back.
          const earlierSessions = (yield* repository.listTaskSessions(task.id)).length;
          const lead = yield* delegate({
            task: buildTaskLeadPrompt({ task, key, spec, approved, memory, otherTasks: active }),
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
            role: approved ? "implementer" : "lead",
            createdAt: started.stageChangedAt,
          });
          yield* appendEvent(started, "stage_changed", "inbox → planning", callerThreadId);
          yield* router.publish(role.projectId);
          return { task: started, leadThreadId: lead.childThreadId };
        }),
      );
    }).pipe(orTeamError("Could not start the task."));

  /** The task a spec tool acts on: a lead's own task, or the one the PM names. */
  const specTaskFor = (callerThreadId: ThreadId, taskId: ProjectTaskId | undefined, tool: string) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], tool);
      const id = taskId ?? (role.type === "lead" ? role.taskId : undefined);
      if (id === undefined) return yield* teamError(`${tool} needs a taskId.`);
      if (role.type === "lead" && id !== role.taskId) {
        return yield* teamError("A task lead can only use its own task's spec.", role.projectId);
      }
      return { task: yield* requireTask(id, role.projectId), author: role.type };
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
      const { task } = yield* specTaskFor(callerThreadId, input.taskId, "task_spec_read");
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
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "task_update");
      const taskId = input.taskId ?? (role.type === "lead" ? role.taskId : undefined);
      if (taskId === undefined) return yield* teamError("task_update needs a taskId.");
      if (role.type === "lead" && taskId !== role.taskId) {
        return yield* teamError("A task lead can only update its own task.", role.projectId);
      }
      const task = yield* requireTask(taskId, role.projectId);
      const updated = yield* setTask({
        id: task.id,
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
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "task_list");
      const tasks = yield* repository.listTasks({
        projectId: role.projectId,
        ...(input.stages === undefined ? {} : { stages: input.stages }),
      });
      const limited = input.limit === undefined ? tasks : tasks.slice(0, input.limit);
      return { tasks: limited.map(toTaskBrief) };
    }).pipe(orTeamError("Could not list tasks."));

  const readTask: ProjectTeamService["Service"]["readTask"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "task_read");
      const task = yield* requireTask(input.taskId, role.projectId);
      const events = yield* repository.listTaskEvents({
        taskId: task.id,
        limit: input.eventLimit ?? DEFAULT_TASK_EVENT_LIMIT,
      });
      const openAttention = yield* repository.listOpenAttentionItems({
        projectId: role.projectId,
        taskId: task.id,
      });
      return { task, events, openAttention };
    }).pipe(orTeamError("Could not read the task."));

  const searchTasks: ProjectTeamService["Service"]["searchTasks"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "task_search");
      const tasks = yield* repository.searchTasks({
        projectId: role.projectId,
        query: input.query,
        limit: input.limit ?? DEFAULT_TASK_SEARCH_LIMIT,
      });
      return { tasks };
    }).pipe(orTeamError("Could not search tasks."));

  const teamStatus: ProjectTeamService["Service"]["teamStatus"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "team_status");
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
      const briefs = (stage: ProjectTaskStage) =>
        tasks.filter((task) => task.stage === stage).map(toTaskBrief);
      const changedSince = (task: ProjectTask) => isoMillis(task.stageChangedAt) > sinceMs;
      const openAttention = yield* repository.listOpenAttentionItems({ projectId });
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
      if (role.type === "pm") yield* sitreps.noteStatusRead(projectId);
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
          running: briefs("running"),
          in_review: briefs("in_review"),
          done: briefs("done"),
          blocked: briefs("blocked"),
          cancelled: briefs("cancelled"),
        },
        stalled: tasks
          .filter((task) => task.lastOutcome === "stalled" && LIVE_TASK_STAGES.has(task.stage))
          .map(toTaskBrief),
        openAttention,
        settings: manager.settings,
        changes: {
          since,
          done: tasks
            .filter((task) => task.stage === "done" && changedSince(task))
            .map(toTaskBrief),
          prOpened: tasks
            .filter(
              (task) => task.stage === "in_review" && task.prUrl !== null && changedSince(task),
            )
            .map(toTaskBrief),
          newAttention,
          blocked: tasks
            .filter((task) => task.stage === "blocked" && changedSince(task))
            .map(toTaskBrief),
          otherThreads: otherThreads.filter((thread) => isoMillis(thread.lastUpdateAt) > sinceMs),
        },
        otherThreads,
        journal,
        memoryTopics,
      } satisfies ProjectTeamStatus;
    }).pipe(orTeamError("Could not read the team status."));

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
          const { quietHours: _previousQuietHours, ...current } = manager.settings;
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
      yield* router.publish(projectId);
      return { projectId, settings };
    }).pipe(orTeamError("Could not update the team settings.", projectId));

  const updateSettingsAsManager: ProjectTeamService["Service"]["updateSettingsAsManager"] = (
    callerThreadId,
    input,
  ) =>
    requireRole(callerThreadId, ["pm"], "team_settings_update").pipe(
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

  const askUser: ProjectTeamService["Service"]["askUser"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["lead"], "ask_user");
      const task = yield* requireTask(role.taskId, role.projectId);
      const item = yield* router.ask({
        task,
        kind: input.kind,
        question: input.question,
        options:
          input.options ??
          (input.kind === "approval" ? [PLAN_APPROVAL_START, PLAN_APPROVAL_ONLY] : []),
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
      const answered = yield* router.answer({
        item: item.value,
        answer: input.answer,
        senderThreadId: callerThreadId,
      });
      return { item: answered };
    }).pipe(orTeamError("Could not answer the question."));

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
        children: (yield* repository.listChildTasks(task.id)).map(toTaskBrief),
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
      const task = yield* repository.createTask({
        id: ProjectTaskId.make(yield* newId("task")),
        projectId: input.projectId,
        title: input.title,
        request: context.length > 0 ? context : input.title,
        waitsOn: [],
        parentTaskId: input.parentTaskId,
        spec: { background: context, goal: "", nonGoals: "", todos: [] },
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
            spec: { background: todo.text, goal: "", nonGoals: "", todos: [] },
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
      });
      const task = yield* requireTask(answered.taskId, answered.projectId);
      yield* appendEvent(task, "note", `The user answered (${answered.kind}).`, null);
      return { item: answered };
    }).pipe(orTeamError("Could not answer the question.", input.projectId));

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
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "memory_list");
      return { entries: yield* repository.listMemory(role.projectId) };
    }).pipe(orTeamError("Could not read the project memory."));

  const writeMemory: ProjectTeamService["Service"]["writeMemory"] = (callerThreadId, input) =>
    Effect.gen(function* () {
      const role = yield* requireRole(callerThreadId, ["pm", "lead"], "memory_write");
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
      const role = yield* requireRole(callerThreadId, ["pm"], "memory_delete");
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
          return {
            projectId,
            pmThreadId: manager.threadId,
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
            tasks: tasks.map((task) => ({
              id: task.id,
              number: task.number,
              parentTaskId: task.parentTaskId,
              title: task.title,
              stage: task.stage,
              leadThreadId: task.leadThreadId,
              prUrl: task.prUrl,
              lastOutcome: task.lastOutcome,
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
    listMemory,
    writeMemory,
    deleteMemory,
    requestSitrep,
    attentionSnapshot,
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
