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
  type ProjectId,
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
  type ProjectTeamMemoryDeleteInput,
  type ProjectTeamMemoryDeleteResult,
  type ProjectTeamMemoryListResult,
  type ProjectTeamMemoryWriteInput,
  type ProjectTeamMemoryWriteResult,
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
import {
  MINUTE_MS,
  isoFromMillis,
  isoMillis,
  makeIdGenerator,
  nowIso,
  orTeamError,
  teamError,
} from "./common.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import { buildTaskLeadPrompt, nextStepHint } from "./taskLeadPrompt.ts";

export const MAX_TASK_NUDGES = 2;
export const SETTINGS_PIN_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_TASK_EVENT_LIMIT = 20;
const DEFAULT_TASK_SEARCH_LIMIT = 20;
const LEAD_MESSAGE_SUMMARY_MAX_CHARS = 300;
/** Stages whose task lead has work to show; stalled tasks come from these. */
const LIVE_TASK_STAGES: ReadonlySet<ProjectTaskStage> = new Set([
  "planning",
  "running",
  "in_review",
]);

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
      const updated = yield* repository.updateTask({ ...input, now: yield* nowIso });
      if (Option.isNone(updated)) return yield* teamError(`Task ${input.id} was not found.`);
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
          if (shell !== null && shell.deletedAt === null) return existing.value;
        }
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
          title: `${project.value.title} PM`,
          modelSelection,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdBy: "system",
          creationSource: "server",
        });
        const manager = yield* repository.upsertManager({
          projectId,
          threadId,
          settings: DEFAULT_PROJECT_TEAM_SETTINGS,
          now: yield* nowIso,
        });
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
      });
      yield* appendEvent(task, "created", task.title, callerThreadId);
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
          const lead = yield* delegate({
            task: buildTaskLeadPrompt({ task, memory, otherTasks: active }),
            title: `#${task.number} ${task.title}`,
            role: "implementation",
            isolation: "worktree",
            mode: "async",
            clientRequestId: `task-start:${task.id}`,
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
          yield* appendEvent(started, "stage_changed", "inbox → planning", callerThreadId);
          return { task: started, leadThreadId: lead.childThreadId };
        }),
      );
    }).pipe(orTeamError("Could not start the task."));

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
      if (input.reason === "user_asked" && role.type === "pm") {
        yield* sitreps.noteUserAsked(projectId);
      }
      return {
        projectId,
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
        },
      } satisfies ProjectTeamStatus;
    }).pipe(orTeamError("Could not read the team status."));

  const applySettings = (
    projectId: ProjectId,
    patch: {
      readonly maxConcurrentTasks?: number | undefined;
      readonly sitrepIntervalMinutes?: number | undefined;
      readonly sitrepNotify?: boolean | undefined;
      readonly quietHours?: ProjectTeamSettings["quietHours"] | null | undefined;
    },
    actorThreadId: ThreadId | null,
  ) =>
    Effect.gen(function* () {
      if (Object.values(patch).every((value) => value === undefined)) {
        return yield* teamError("The settings update has no fields.", projectId);
      }
      const manager = yield* requireManager(projectId);
      const now = yield* nowIso;
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
        // Only setting the interval by hand stops it adapting; other fields keep the pin as is.
        ...(patch.sitrepIntervalMinutes === undefined
          ? {}
          : { pinnedUntil: isoFromMillis(isoMillis(now) + SETTINGS_PIN_MS) }),
      };
      yield* repository.updateManagerSettings({ projectId, settings, now });
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
      Effect.flatMap((role) => applySettings(role.projectId, input, callerThreadId)),
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
        options: input.options ?? [],
        askerThreadId: callerThreadId,
      });
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
          return {
            projectId,
            pmThreadId: manager.threadId,
            openCount: open.length,
            latestBatchId: Option.isSome(latestItem) ? latestItem.value.batchId : null,
            latestSitrepId: Option.isSome(latestPosted) ? latestPosted.value.id : null,
            unreadSitrepCount: yield* repository.countUnreadSitreps(projectId),
            sitrepInProgress: Option.isSome(latestSitrep) && latestSitrep.value.body === null,
            settings: manager.settings,
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
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => attentionSnapshot)),
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
      return { task: updated, event };
    }).pipe(orTeamError("Could not record the task outcome.", input.task.projectId));

  return {
    ensureManager,
    roleOf,
    createTask,
    startTask,
    updateTask,
    nudgeTask,
    listTasks,
    readTask,
    searchTasks,
    teamStatus,
    updateSettingsAsManager,
    updateSettings,
    askUser,
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
  Layer.provideMerge(SitrepScheduler.layer),
  Layer.provideMerge(AttentionRouter.layer),
);
