import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  emptyProjectTaskSpec,
  ExecutionLocation,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectAttentionAnsweredBy,
  ProjectAttentionBatchId,
  ProjectAttentionContext,
  ProjectAttentionDetail,
  ProjectAttentionItem,
  ProjectAttentionItemId,
  ProjectAttentionKind,
  ProjectCorrection,
  ProjectCorrectionKind,
  ProjectCorrectionStage,
  ProjectId,
  ProjectMemoryEntry,
  ProjectMemoryEntryId,
  ProjectSitrep,
  ProjectSitrepId,
  ProjectSitrepReason,
  ProjectTask,
  ProjectTaskEvent,
  ProjectTaskEventId,
  ProjectTaskEventKind,
  ProjectTaskId,
  ProjectTaskOutcome,
  ProjectTaskReady,
  ProjectTaskModelRole,
  ProjectTaskMemoryHold,
  ProjectTaskHold,
  ProjectTaskStallCause,
  ProjectTaskModelStep,
  ProjectTaskModelSteps,
  ProjectTaskMetrics,
  ProjectTaskSize,
  ProjectTaskStepUsages,
  ProjectTaskReview,
  ProjectTaskRoleModels,
  ProjectTaskSession,
  ProjectTaskSessionRole,
  ProjectTaskSpec,
  ProjectTaskSpecAuthor,
  ProjectTaskSpecVersion,
  ProjectTaskStage,
  ProjectTeamSettings,
  ProjectManagerKind,
  ProjectWorkKind,
  ThreadId,
  WorkspaceGoal,
  WorkspaceGoalId,
  WorkspaceGoalLink,
  WorkspaceGoalStatus,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  type ProjectTeamRepositoryError,
  toPersistenceSqlError,
} from "./Errors.ts";

export const ProjectManagerRecord = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  kind: ProjectManagerKind,
  settings: ProjectTeamSettings,
  lastUserMessageAt: Schema.NullOr(IsoDateTime),
  lastSitrepAt: Schema.NullOr(IsoDateTime),
  unreadSitrepStreak: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectManagerRecord = typeof ProjectManagerRecord.Type;

export interface UpsertProjectManagerInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** Defaults to "pm". */
  readonly kind?: ProjectManagerKind;
  /** Used only when the project has no manager yet; an existing manager keeps its settings. */
  readonly settings: ProjectTeamSettings;
  readonly now: IsoDateTime;
}

export interface CreateProjectTaskInput {
  readonly id: ProjectTaskId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly request: string;
  readonly waitsOn: ReadonlyArray<ProjectTaskId>;
  readonly now: IsoDateTime;
  readonly parentTaskId?: ProjectTaskId | undefined;
  /** Spec v1. Defaults to the request as background. */
  readonly spec?: ProjectTaskSpec | undefined;
  /** Who wrote spec v1. Defaults to the PM. */
  readonly author?: ProjectTaskSpecAuthor | undefined;
  readonly authorThreadId?: ThreadId | null | undefined;
}

export interface UpdateProjectTaskInput {
  readonly id: ProjectTaskId;
  readonly now: IsoDateTime;
  readonly stage?: ProjectTaskStage;
  readonly title?: string;
  readonly waitsOn?: ReadonlyArray<ProjectTaskId>;
  /** null removes the parent. */
  readonly parentTaskId?: ProjectTaskId | null;
  readonly leadThreadId?: ThreadId;
  /** Where the task's lead runs; set when the task starts. */
  readonly location?: ExecutionLocation;
  readonly prUrl?: string;
  readonly planSummary?: string;
  readonly resultSummary?: string;
  readonly lastOutcome?: ProjectTaskOutcome;
  readonly nudgeCount?: number;
}

export interface AppendProjectTaskSpecVersionInput {
  readonly taskId: ProjectTaskId;
  readonly spec: ProjectTaskSpec;
  readonly author: ProjectTaskSpecAuthor;
  readonly authorThreadId: ThreadId | null;
  readonly note: string;
  readonly createdAt: IsoDateTime;
}

export interface AppendProjectTaskEventInput {
  readonly id: ProjectTaskEventId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectTaskId | null;
  readonly kind: ProjectTaskEventKind;
  readonly body: string;
  readonly actorThreadId: ThreadId | null;
  readonly createdAt: IsoDateTime;
}

export interface CreateProjectAttentionItemInput {
  readonly id: ProjectAttentionItemId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectTaskId | null;
  readonly kind: ProjectAttentionKind;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly askerThreadId: ThreadId | null;
  readonly batchId: ProjectAttentionBatchId;
  readonly createdAt: IsoDateTime;
  /** For a plan approval: the spec version under review. */
  readonly specVersion?: number | null;
  /** For a plan approval: the card's Goal section. */
  readonly summary?: string | null;
  /** For a plan approval: the card's Verification section. */
  readonly verification?: string | null;
  readonly context?: ProjectAttentionContext | null;
  readonly details?: ReadonlyArray<ProjectAttentionDetail> | null;
  readonly senderRole?: ProjectAttentionItem["senderRole"] | undefined;
  readonly senderName?: string | null | undefined;
}

export type InsertProjectCorrectionInput = ProjectCorrection;

export interface CreateProjectSitrepInput {
  readonly id: ProjectSitrepId;
  readonly projectId: ProjectId;
  readonly since: IsoDateTime | null;
  readonly reason: ProjectSitrepReason;
  readonly createdAt: IsoDateTime;
}

type Result<A> = Effect.Effect<A, ProjectTeamRepositoryError>;

export const ProjectTaskStallRecord = Schema.Struct({
  stallId: Schema.String,
  taskId: ProjectTaskId,
  cause: ProjectTaskStallCause,
  startedAt: IsoDateTime,
  wokeAt: Schema.NullOr(IsoDateTime),
  notifiedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectTaskStallRecord = typeof ProjectTaskStallRecord.Type;

export class ProjectTeamRepository extends Context.Service<
  ProjectTeamRepository,
  {
    readonly getManager: (projectId: ProjectId) => Result<Option.Option<ProjectManagerRecord>>;
    readonly getManagerByThreadId: (
      threadId: ThreadId,
    ) => Result<Option.Option<ProjectManagerRecord>>;
    readonly listManagers: () => Result<ReadonlyArray<ProjectManagerRecord>>;
    readonly upsertManager: (input: UpsertProjectManagerInput) => Result<ProjectManagerRecord>;
    /** Forgets the project's PM; its thread is left to the caller. */
    readonly deleteManager: (projectId: ProjectId) => Result<void>;
    readonly updateManagerSettings: (input: {
      readonly projectId: ProjectId;
      readonly settings: ProjectTeamSettings;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectManagerRecord>>;
    /** Sets last_user_message_at and clears the unread sitrep streak. */
    readonly recordUserMessage: (input: {
      readonly projectId: ProjectId;
      readonly at: IsoDateTime;
    }) => Result<Option.Option<ProjectManagerRecord>>;
    /** Sets last_sitrep_at and adds one to the unread sitrep streak. */
    readonly recordSitrepPosted: (input: {
      readonly projectId: ProjectId;
      readonly at: IsoDateTime;
    }) => Result<Option.Option<ProjectManagerRecord>>;
    readonly setUnreadSitrepStreak: (input: {
      readonly projectId: ProjectId;
      readonly streak: number;
      readonly now: IsoDateTime;
    }) => Result<void>;

    /** Creates an inbox task numbered one past the project's highest number. */
    readonly createTask: (input: CreateProjectTaskInput) => Result<ProjectTask>;
    readonly getTask: (id: ProjectTaskId) => Result<Option.Option<ProjectTask>>;
    readonly listTasks: (input: {
      readonly projectId: ProjectId;
      readonly stages?: ReadonlyArray<ProjectTaskStage>;
    }) => Result<ReadonlyArray<ProjectTask>>;
    readonly findTaskByLeadThreadId: (threadId: ThreadId) => Result<Option.Option<ProjectTask>>;
    readonly listChildTasks: (parentTaskId: ProjectTaskId) => Result<ReadonlyArray<ProjectTask>>;
    /** Tasks in any project whose waitsOn includes the task. */
    readonly listTasksWaitingOn: (taskId: ProjectTaskId) => Result<ReadonlyArray<ProjectTask>>;

    /** Oldest first. */
    readonly listSpecVersions: (
      taskId: ProjectTaskId,
    ) => Result<ReadonlyArray<ProjectTaskSpecVersion>>;
    readonly getLatestSpecVersion: (
      taskId: ProjectTaskId,
    ) => Result<Option.Option<ProjectTaskSpecVersion>>;
    /** Each of the project's tasks with a spec, and its latest version number, without reading the specs. */
    readonly listLatestSpecVersionNumbers: (
      projectId: ProjectId,
    ) => Result<ReadonlyMap<ProjectTaskId, number>>;
    readonly getSpecVersion: (input: {
      readonly taskId: ProjectTaskId;
      readonly version: number;
    }) => Result<Option.Option<ProjectTaskSpecVersion>>;
    /** Stores the spec as the next version number. */
    readonly appendSpecVersion: (
      input: AppendProjectTaskSpecVersionInput,
    ) => Result<ProjectTaskSpecVersion>;
    /** Links an agent thread to a task; linking it again keeps the first role. */
    readonly addTaskSession: (input: {
      readonly taskId: ProjectTaskId;
      readonly threadId: ThreadId;
      readonly role: ProjectTaskSessionRole;
      readonly createdAt: IsoDateTime;
    }) => Result<void>;
    /** Oldest first. */
    readonly listTaskSessions: (taskId: ProjectTaskId) => Result<ReadonlyArray<ProjectTaskSession>>;
    /**
     * Updates the given fields. A stage change also sets stage_changed_at and
     * resets nudge_count to 0, overriding a nudgeCount in the same call, and clears the
     * ready flag. A move into running starts an Iterate round (resuming from blocked does
     * not, unless none has started); the first move into in_review starts Ship round 1.
     * Later Ship rounds come from the watched pull request (`reopenShipRound`).
     */
    readonly updateTask: (input: UpdateProjectTaskInput) => Result<Option.Option<ProjectTask>>;
    /**
     * Stores the lead's latest self-review and clears the ready flag, since a new review
     * means new work; `startsIterateRound` also counts a new round.
     */
    readonly recordTaskReview: (input: {
      readonly id: ProjectTaskId;
      readonly review: ProjectTaskReview;
      readonly startsIterateRound: boolean;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /** Stores the Ready gate's pass, or clears it with null. */
    readonly setTaskReady: (input: {
      readonly id: ProjectTaskId;
      readonly ready: ProjectTaskReady | null;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /**
     * A failed check, new comment or conflict on an in-review task's pull request: starts
     * the next Ship round and clears the ready flag. None when the task is not in review.
     */
    readonly reopenShipRound: (input: {
      readonly id: ProjectTaskId;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /**
     * Sets or clears where the task's lead is being moved, and its location when given.
     * `expectedMoveTarget` makes the write conditional; none when it does not match.
     */
    readonly setTaskMove: (input: {
      readonly id: ProjectTaskId;
      readonly moveTarget: ExecutionLocation | null;
      readonly location?: ExecutionLocation;
      readonly expectedMoveTarget?: ExecutionLocation | null;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /** Tasks with a move in progress, in any project. */
    readonly listMovingTasks: () => Result<ReadonlyArray<ProjectTask>>;
    /** Sets or clears why the task is held for memory; clearing it ends any stall. */
    readonly setTaskMemoryHold: (input: {
      readonly id: ProjectTaskId;
      readonly memoryHold: ProjectTaskMemoryHold | null;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /**
     * Starts (from `at`, unless one is running) or ends (at `at`) the time a held
     * task's hold is holding back work, which ending adds to its memoryStallMs.
     */
    readonly setTaskMemoryStall: (input: {
      readonly id: ProjectTaskId;
      readonly stalling: boolean;
      readonly at: IsoDateTime;
      /** When a stall starts: whether the location setting is local only, kept apart in the metrics. */
      readonly localOnly?: boolean;
    }) => Result<Option.Option<ProjectTask>>;
    /** Sets or clears the task's hold: a deliberate stop and its resume condition. */
    readonly setTaskHold: (input: {
      readonly id: ProjectTaskId;
      readonly hold: ProjectTaskHold | null;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /** Opens a stall of this cause for the task unless one is open; returns the open one. */
    readonly openTaskStall: (input: {
      readonly stallId: string;
      readonly taskId: ProjectTaskId;
      readonly cause: ProjectTaskStallCause;
      readonly startedAt: IsoDateTime;
    }) => Result<ProjectTaskStallRecord>;
    /** Every stall of a task, open or ended, oldest first. */
    readonly listTaskStalls: (input: {
      readonly taskId: ProjectTaskId;
    }) => Result<ReadonlyArray<ProjectTaskStallRecord>>;
    /** Open stalls, of one task or of every task. */
    readonly listOpenTaskStalls: (input: {
      readonly taskId?: ProjectTaskId;
    }) => Result<ReadonlyArray<ProjectTaskStallRecord>>;
    /** Records that the server woke the lead or told the user about an open stall. */
    readonly markTaskStall: (input: {
      readonly stallId: string;
      readonly wokeAt?: IsoDateTime;
      readonly notifiedAt?: IsoDateTime;
    }) => Result<void>;
    /** Ends the task's open stalls at `endedAt` and adds their time to its metrics. */
    readonly closeTaskStalls: (input: {
      readonly taskId: ProjectTaskId;
      readonly endedAt: IsoDateTime;
    }) => Result<ReadonlyArray<ProjectTaskStallRecord>>;
    /** Tasks held for memory, in any project, lowest number first. */
    readonly listMemoryHeldTasks: () => Result<ReadonlyArray<ProjectTask>>;
    /** Replaces the task's own model per role. */
    readonly setTaskRoleModels: (input: {
      readonly id: ProjectTaskId;
      readonly roleModels: ProjectTaskRoleModels;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /** Records the model that just ran a role, replacing the role's previous step. */
    readonly recordModelStep: (input: {
      readonly id: ProjectTaskId;
      readonly role: ProjectTaskModelRole;
      readonly step: ProjectTaskModelStep;
    }) => Result<Option.Option<ProjectTask>>;
    /** The task and role a session thread works on, if it is linked to one. */
    readonly findTaskSessionByThreadId: (
      threadId: ThreadId,
    ) => Result<Option.Option<ProjectTaskSession>>;
    /**
     * Opens the usage row of a model session (the lead, or a task_delegate child). Opening
     * it again keeps the first row, so a session reused for later runs adds to it. True
     * when this call opened it; a fix step's first opening also counts a fix round.
     */
    readonly startModelRun: (input: StartProjectTaskModelRunInput) => Result<boolean>;
    /** The usage row of a session thread, if it has one. */
    readonly findModelRunByThreadId: (
      threadId: ThreadId,
    ) => Result<Option.Option<ProjectTaskModelRun>>;
    /**
     * Adds one finished run to a session's row and refreshes the task's per-role totals.
     * None when the session has no row.
     */
    readonly addModelRunUsage: (
      input: AddProjectTaskModelRunUsageInput,
    ) => Result<Option.Option<ProjectTask>>;
    /** Adds to one of the task's outcome counts. */
    readonly bumpTaskMetric: (input: {
      readonly id: ProjectTaskId;
      readonly metric: "reviewFindings" | "fixRounds" | "ciFailures";
      readonly by: number;
    }) => Result<Option.Option<ProjectTask>>;
    readonly setTaskSize: (input: {
      readonly id: ProjectTaskId;
      readonly size: ProjectTaskSize;
      readonly now: IsoDateTime;
    }) => Result<Option.Option<ProjectTask>>;
    /** Case-insensitive substring match over title, request, plan and result summaries. */
    readonly searchTasks: (input: {
      readonly projectId: ProjectId;
      readonly query: string;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectTask>>;

    readonly appendTaskEvent: (input: AppendProjectTaskEventInput) => Result<ProjectTaskEvent>;
    /** The most recent events for a task, oldest first. */
    readonly listTaskEvents: (input: {
      readonly taskId: ProjectTaskId;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectTaskEvent>>;
    /** The newest log entry a thread wrote in a project. */
    readonly getLatestEventByActor: (input: {
      readonly projectId: ProjectId;
      readonly actorThreadId: ThreadId;
    }) => Result<Option.Option<ProjectTaskEvent>>;
    readonly listProjectEventsSince: (input: {
      readonly projectId: ProjectId;
      readonly since: IsoDateTime;
    }) => Result<ReadonlyArray<ProjectTaskEvent>>;
    /** The newest stage changes to done, failed outcomes and leads' plans, newest first. */
    readonly listRecentTaskEndings: (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectTaskEvent>>;

    readonly createAttentionItem: (
      input: CreateProjectAttentionItemInput,
    ) => Result<ProjectAttentionItem>;
    readonly getAttentionItem: (
      id: ProjectAttentionItemId,
    ) => Result<Option.Option<ProjectAttentionItem>>;
    /** None when the item does not exist, was already answered, or was replaced. */
    readonly answerAttentionItem: (input: {
      readonly id: ProjectAttentionItemId;
      readonly answer: string;
      readonly answeredAt: IsoDateTime;
      readonly answeredBy: ProjectAttentionAnsweredBy;
    }) => Result<Option.Option<ProjectAttentionItem>>;
    /** Closes one item without an answer. None when it does not exist or is already closed. */
    readonly supersedeAttentionItem: (input: {
      readonly id: ProjectAttentionItemId;
      readonly supersededAt: IsoDateTime;
    }) => Result<Option.Option<ProjectAttentionItem>>;
    /** Closes the task's open items (of one kind, or all) without an answer; returns the closed items. */
    readonly supersedeOpenAttentionItems: (input: {
      readonly taskId: ProjectTaskId;
      readonly kind?: ProjectAttentionKind;
      readonly supersededAt: IsoDateTime;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** The newest answered or replaced items, newest first. */
    readonly listRecentClosedAttentionItems: (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    readonly listOpenAttentionItems: (input: {
      readonly projectId: ProjectId;
      readonly taskId?: ProjectTaskId;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    readonly listAttentionItemsSince: (input: {
      readonly projectId: ProjectId;
      readonly since: IsoDateTime;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** A task's answered items of one kind, oldest answer first. */
    readonly listAnsweredTaskAttentionItems: (input: {
      readonly taskId: ProjectTaskId;
      readonly kind: ProjectAttentionKind;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** The most recently answered items, newest answer first. */
    readonly listRecentlyAnsweredAttentionItems: (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** A project's answered items of one kind, oldest answer first. */
    readonly listAnsweredAttentionItems: (input: {
      readonly projectId: ProjectId;
      readonly kind: ProjectAttentionKind;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** The newest item, answered or not, for batching. */
    readonly getLatestAttentionItem: (
      projectId: ProjectId,
    ) => Result<Option.Option<ProjectAttentionItem>>;

    /**
     * Stores a correction unless one with its source key exists. Returns the stored row and
     * whether this call added it.
     */
    readonly insertCorrection: (
      input: InsertProjectCorrectionInput,
    ) => Result<{ readonly inserted: boolean; readonly correction: ProjectCorrection }>;
    /** When live correction recording started; older moments are filled by the backfill. */
    readonly getCorrectionsStartedAt: () => Result<IsoDateTime>;
    /** Corrections, oldest first; all projects when projectId is absent. */
    readonly listCorrections: (input: {
      readonly projectId?: ProjectId | undefined;
      readonly since?: IsoDateTime | undefined;
    }) => Result<ReadonlyArray<ProjectCorrection>>;

    readonly listMemory: (projectId: ProjectId) => Result<ReadonlyArray<ProjectMemoryEntry>>;
    /** Replaces the content for a topic; a new topic takes the given id. */
    readonly upsertMemory: (input: {
      readonly id: ProjectMemoryEntryId;
      readonly projectId: ProjectId;
      readonly topic: string;
      readonly content: string;
      readonly updatedAt: IsoDateTime;
    }) => Result<ProjectMemoryEntry>;
    readonly deleteMemory: (input: {
      readonly projectId: ProjectId;
      readonly topic: string;
    }) => Result<boolean>;

    /** Every workspace goal with its links, in position order. */
    readonly listWorkspaceGoals: () => Result<ReadonlyArray<WorkspaceGoal>>;
    /** Writes the goal and replaces its links with the given ones. */
    readonly saveWorkspaceGoal: (goal: WorkspaceGoal) => Result<void>;

    readonly createSitrep: (input: CreateProjectSitrepInput) => Result<ProjectSitrep>;
    readonly setSitrepBody: (input: {
      readonly id: ProjectSitrepId;
      readonly body: string;
    }) => Result<Option.Option<ProjectSitrep>>;
    /** Marks every posted, unread sitrep of the project as read. Returns how many changed. */
    readonly markSitrepsRead: (input: {
      readonly projectId: ProjectId;
      readonly readAt: IsoDateTime;
    }) => Result<number>;
    readonly getLatestSitrep: (projectId: ProjectId) => Result<Option.Option<ProjectSitrep>>;
    /** The newest sitrep that has a body. */
    readonly getLatestPostedSitrep: (projectId: ProjectId) => Result<Option.Option<ProjectSitrep>>;
    /** The newest sitreps that have a body, newest first. */
    readonly listRecentPostedSitreps: (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectSitrep>>;
    /** Posted sitreps (with a body) that are not read yet. */
    readonly countUnreadSitreps: (projectId: ProjectId) => Result<number>;
  }
>()("t3/persistence/ProjectTeamRepository") {}

/** One model session's usage on a task, summed over its runs. */
export const ProjectTaskModelRun = Schema.Struct({
  taskId: ProjectTaskId,
  threadId: ThreadId,
  role: ProjectTaskModelRole,
  providerInstanceId: Schema.String,
  model: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  durationMs: NonNegativeInt,
  runCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  costUsd: Schema.NullOr(Schema.Number),
});
export type ProjectTaskModelRun = typeof ProjectTaskModelRun.Type;

export interface StartProjectTaskModelRunInput {
  readonly taskId: ProjectTaskId;
  readonly threadId: ThreadId;
  readonly role: ProjectTaskModelRole;
  readonly providerInstanceId: string;
  readonly model: string | null;
  readonly startedAt: IsoDateTime;
  /** A fix step: opening its row also counts a fix round on the task. */
  readonly countsFixRound?: boolean;
}

export interface AddProjectTaskModelRunUsageInput {
  readonly threadId: ThreadId;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly finishedAt: IsoDateTime;
}

const ManagerRow = Schema.Struct({
  ...ProjectManagerRecord.fields,
  settings: Schema.fromJsonString(ProjectTeamSettings),
});
const TaskRow = Schema.Struct({
  ...ProjectTask.fields,
  waitsOn: Schema.fromJsonString(Schema.Array(ProjectTaskId)),
  review: Schema.NullOr(Schema.fromJsonString(ProjectTaskReview)),
  ready: Schema.NullOr(Schema.fromJsonString(ProjectTaskReady)),
  roleModels: Schema.fromJsonString(ProjectTaskRoleModels),
  modelSteps: Schema.fromJsonString(ProjectTaskModelSteps),
  stepUsage: Schema.fromJsonString(ProjectTaskStepUsages),
  metrics: Schema.fromJsonString(ProjectTaskMetrics),
  hold: Schema.NullOr(Schema.fromJsonString(ProjectTaskHold)),
});
const HoldJson = Schema.NullOr(Schema.fromJsonString(ProjectTaskHold));
const RoleModelsJson = Schema.fromJsonString(ProjectTaskRoleModels);
const ModelStepJson = Schema.fromJsonString(ProjectTaskModelStep);
const ReviewJson = Schema.fromJsonString(ProjectTaskReview);
const ReadyJson = Schema.NullOr(Schema.fromJsonString(ProjectTaskReady));
const AttentionRow = Schema.Struct({
  ...ProjectAttentionItem.fields,
  supersededAt: Schema.NullOr(IsoDateTime),
  answeredBy: Schema.NullOr(ProjectAttentionAnsweredBy),
  specVersion: Schema.NullOr(PositiveInt),
  summary: Schema.NullOr(Schema.String),
  verification: Schema.NullOr(Schema.String),
  options: Schema.fromJsonString(Schema.Array(Schema.String)),
  context: Schema.NullOr(Schema.fromJsonString(ProjectAttentionContext)),
  senderRole: ProjectAttentionItem.fields.senderRole,
  senderName: ProjectAttentionItem.fields.senderName,
  details: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProjectAttentionDetail))),
});
const SpecVersionRow = Schema.Struct({
  ...ProjectTaskSpecVersion.fields,
  spec: Schema.fromJsonString(ProjectTaskSpec),
});
const CorrectionRow = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  taskId: ProjectTaskId,
  kind: ProjectCorrectionKind,
  stage: ProjectCorrectionStage,
  workKind: ProjectWorkKind,
  userText: Schema.String,
  whatDiffered: Schema.String,
  sourceKey: Schema.String,
  backfilled: Schema.Number,
  createdAt: IsoDateTime,
});
const toCorrection = (row: typeof CorrectionRow.Type): ProjectCorrection => ({
  ...row,
  backfilled: row.backfilled !== 0,
});
const CountRow = Schema.Struct({ count: NonNegativeInt });
const IdRow = Schema.Struct({ id: Schema.String });

const SettingsJson = Schema.fromJsonString(ProjectTeamSettings);
const WaitsOnJson = Schema.fromJsonString(Schema.Array(ProjectTaskId));
const OptionsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const SpecJson = Schema.fromJsonString(ProjectTaskSpec);

const ProjectIdRequest = Schema.Struct({ projectId: ProjectId });

function toRepositoryError(operation: string) {
  const name = `ProjectTeamRepository.${operation}`;
  return (cause: unknown): ProjectTeamRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(name, cause)
      : toPersistenceSqlError(name)(cause);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const managerColumns = sql.literal(`
    project_id AS "projectId",
    thread_id AS "threadId",
    kind AS "kind",
    settings_json AS "settings",
    last_user_message_at AS "lastUserMessageAt",
    last_sitrep_at AS "lastSitrepAt",
    unread_sitrep_streak AS "unreadSitrepStreak",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `);
  const taskColumns = sql.literal(`
    task_id AS "id",
    project_id AS "projectId",
    number AS "number",
    title AS "title",
    request AS "request",
    stage AS "stage",
    waits_on_json AS "waitsOn",
    parent_task_id AS "parentTaskId",
    lead_thread_id AS "leadThreadId",
    location AS "location",
    move_target AS "moveTarget",
    memory_hold AS "memoryHold",
    hold_json AS "hold",
    pr_url AS "prUrl",
    plan_summary AS "planSummary",
    result_summary AS "resultSummary",
    last_outcome AS "lastOutcome",
    nudge_count AS "nudgeCount",
    iterate_round AS "iterateRound",
    ship_round AS "shipRound",
    review_json AS "review",
    ready_json AS "ready",
    role_models_json AS "roleModels",
    model_steps_json AS "modelSteps",
    step_usage_json AS "stepUsage",
    metrics_json AS "metrics",
    stage_changed_at AS "stageChangedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `);
  const eventColumns = sql.literal(`
    event_id AS "id",
    project_id AS "projectId",
    task_id AS "taskId",
    kind AS "kind",
    body AS "body",
    actor_thread_id AS "actorThreadId",
    created_at AS "createdAt"
  `);
  const attentionColumns = sql.literal(`
    item_id AS "id",
    project_id AS "projectId",
    task_id AS "taskId",
    kind AS "kind",
    question AS "question",
    options_json AS "options",
    answer AS "answer",
    answered_at AS "answeredAt",
    asker_thread_id AS "askerThreadId",
    batch_id AS "batchId",
    created_at AS "createdAt",
    superseded_at AS "supersededAt",
    answered_by AS "answeredBy",
    spec_version AS "specVersion",
    summary AS "summary",
    verification AS "verification",
    context_json AS "context",
    details_json AS "details",
    sender_role AS "senderRole",
    sender_name AS "senderName"
  `);
  const memoryColumns = sql.literal(`
    entry_id AS "id",
    project_id AS "projectId",
    topic AS "topic",
    content AS "content",
    updated_at AS "updatedAt"
  `);
  const sitrepColumns = sql.literal(`
    sitrep_id AS "id",
    project_id AS "projectId",
    since AS "since",
    body AS "body",
    reason AS "reason",
    created_at AS "createdAt",
    read_at AS "readAt"
  `);

  // Managers

  const findManager = SqlSchema.findOneOption({
    Request: ProjectIdRequest,
    Result: ManagerRow,
    execute: ({ projectId }) =>
      sql`SELECT ${managerColumns} FROM project_managers WHERE project_id = ${projectId}`,
  });
  const findManagerByThread = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ManagerRow,
    execute: ({ threadId }) =>
      sql`SELECT ${managerColumns} FROM project_managers WHERE thread_id = ${threadId}`,
  });
  const findManagers = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: ManagerRow,
    execute: () =>
      sql`SELECT ${managerColumns} FROM project_managers ORDER BY created_at ASC, project_id ASC`,
  });
  const upsertManagerRow = SqlSchema.findOne({
    Request: Schema.Struct({
      projectId: ProjectId,
      threadId: ThreadId,
      kind: ProjectManagerKind,
      settings: SettingsJson,
      now: IsoDateTime,
    }),
    Result: ManagerRow,
    execute: ({ projectId, threadId, kind, settings, now }) => sql`
      INSERT INTO project_managers (project_id, thread_id, kind, settings_json, created_at, updated_at)
      VALUES (${projectId}, ${threadId}, ${kind}, ${settings}, ${now}, ${now})
      ON CONFLICT (project_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        kind = excluded.kind,
        updated_at = excluded.updated_at
      RETURNING ${managerColumns}
    `,
  });
  const updateManagerSettingsRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, settings: SettingsJson, now: IsoDateTime }),
    Result: ManagerRow,
    execute: ({ projectId, settings, now }) => sql`
      UPDATE project_managers
      SET settings_json = ${settings}, updated_at = ${now}
      WHERE project_id = ${projectId}
      RETURNING ${managerColumns}
    `,
  });
  const recordUserMessageRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, at: IsoDateTime }),
    Result: ManagerRow,
    execute: ({ projectId, at }) => sql`
      UPDATE project_managers
      SET last_user_message_at = ${at}, unread_sitrep_streak = 0, updated_at = ${at}
      WHERE project_id = ${projectId}
      RETURNING ${managerColumns}
    `,
  });
  const recordSitrepPostedRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, at: IsoDateTime }),
    Result: ManagerRow,
    execute: ({ projectId, at }) => sql`
      UPDATE project_managers
      SET last_sitrep_at = ${at},
        unread_sitrep_streak = unread_sitrep_streak + 1,
        updated_at = ${at}
      WHERE project_id = ${projectId}
      RETURNING ${managerColumns}
    `,
  });
  const deleteManagerRow = SqlSchema.void({
    Request: ProjectIdRequest,
    execute: ({ projectId }) => sql`DELETE FROM project_managers WHERE project_id = ${projectId}`,
  });
  const setUnreadSitrepStreakRow = SqlSchema.void({
    Request: Schema.Struct({ projectId: ProjectId, streak: NonNegativeInt, now: IsoDateTime }),
    execute: ({ projectId, streak, now }) => sql`
      UPDATE project_managers
      SET unread_sitrep_streak = ${streak}, updated_at = ${now}
      WHERE project_id = ${projectId}
    `,
  });

  // Tasks

  const insertTask = SqlSchema.findOne({
    Request: Schema.Struct({
      id: ProjectTaskId,
      projectId: ProjectId,
      title: Schema.String,
      request: Schema.String,
      waitsOn: WaitsOnJson,
      parentTaskId: Schema.NullOr(ProjectTaskId),
      now: IsoDateTime,
    }),
    Result: TaskRow,
    execute: ({ id, projectId, title, request, waitsOn, parentTaskId, now }) => sql`
      INSERT INTO project_tasks (
        task_id, project_id, number, title, request, stage, waits_on_json, parent_task_id,
        nudge_count, stage_changed_at, created_at, updated_at
      )
      SELECT
        ${id}, ${projectId}, COALESCE(MAX(number), 0) + 1, ${title}, ${request}, 'inbox',
        ${waitsOn}, ${parentTaskId}, 0, ${now}, ${now}, ${now}
      FROM project_tasks
      WHERE project_id = ${projectId}
      RETURNING ${taskColumns}
    `,
  });
  const findTask = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId }),
    Result: TaskRow,
    execute: ({ id }) => sql`SELECT ${taskColumns} FROM project_tasks WHERE task_id = ${id}`,
  });
  const findTasks = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      stages: Schema.optional(Schema.Array(ProjectTaskStage)),
    }),
    Result: TaskRow,
    execute: ({ projectId, stages }) => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE ${sql.and([
        sql`project_id = ${projectId}`,
        ...(stages === undefined ? [] : [sql.in("stage", stages)]),
      ])}
      ORDER BY number ASC
    `,
  });
  const findTaskByLead = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: TaskRow,
    execute: ({ threadId }) => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE lead_thread_id = ${threadId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
  });
  /**
   * metrics_json with the open memory hold's length, up to `now`, added to
   * memoryStallMs, and to memoryLocalOnlyStallMs when it began under local only.
   */
  const metricsWithMemoryStall = (now: string) => {
    const elapsed = sql`MAX(
      0,
      CAST(ROUND((julianday(${now}) - julianday(memory_stall_since)) * 86400000) AS INTEGER)
    )`;
    return sql`
      CASE WHEN memory_stall_since IS NULL THEN metrics_json ELSE json_set(
        metrics_json,
        '$.memoryStallMs',
        COALESCE(json_extract(metrics_json, '$.memoryStallMs'), 0) + ${elapsed},
        '$.memoryLocalOnlyStallMs',
        COALESCE(json_extract(metrics_json, '$.memoryLocalOnlyStallMs'), 0) +
          CASE WHEN memory_stall_local_only = 1 THEN ${elapsed} ELSE 0 END
      ) END
    `;
  };
  const updateTaskRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectTaskId,
      now: IsoDateTime,
      stage: Schema.optional(ProjectTaskStage),
      title: Schema.optional(Schema.String),
      waitsOn: Schema.optional(WaitsOnJson),
      parentTaskId: Schema.optional(Schema.NullOr(ProjectTaskId)),
      leadThreadId: Schema.optional(ThreadId),
      location: Schema.optional(ExecutionLocation),
      prUrl: Schema.optional(Schema.String),
      planSummary: Schema.optional(Schema.String),
      resultSummary: Schema.optional(Schema.String),
      lastOutcome: Schema.optional(ProjectTaskOutcome),
      nudgeCount: Schema.optional(NonNegativeInt),
    }),
    Result: TaskRow,
    execute: (input) => {
      const stage = input.stage ?? null;
      const stageChanged = sql`(${stage} IS NOT NULL AND ${stage} <> stage)`;
      const setParent = input.parentTaskId === undefined ? 0 : 1;
      // Finishing ends a memory stall and a wait to start. A "paused" hold stays as a
      // marker that the lead's queue was held for memory, so reopening the task
      // resumes exactly those messages (FinishedTaskCleanup.reviveLead).
      return sql`
        UPDATE project_tasks SET
          stage = COALESCE(${stage}, stage),
          stage_changed_at = CASE WHEN ${stageChanged} THEN ${input.now} ELSE stage_changed_at END,
          nudge_count = CASE
            WHEN ${stageChanged} THEN 0
            ELSE COALESCE(${input.nudgeCount ?? null}, nudge_count)
          END,
          iterate_round = CASE
            WHEN ${stageChanged} AND ${stage} = 'running' AND (stage <> 'blocked' OR iterate_round = 0)
              THEN iterate_round + 1
            ELSE iterate_round
          END,
          ship_round = CASE
            WHEN ${stageChanged} AND ${stage} = 'in_review' AND ship_round = 0 THEN 1
            ELSE ship_round
          END,
          ready_json = CASE WHEN ${stageChanged} THEN NULL ELSE ready_json END,
          metrics_json = CASE
            WHEN ${stageChanged} AND ${stage} IN ('done', 'cancelled')
              THEN ${metricsWithMemoryStall(input.now)}
            ELSE metrics_json
          END,
          memory_stall_since = CASE
            WHEN ${stageChanged} AND ${stage} IN ('done', 'cancelled') THEN NULL
            ELSE memory_stall_since
          END,
          memory_hold = CASE
            WHEN ${stageChanged} AND ${stage} IN ('done', 'cancelled') AND memory_hold = 'waiting'
              THEN NULL
            ELSE memory_hold
          END,
          title = COALESCE(${input.title ?? null}, title),
          waits_on_json = COALESCE(${input.waitsOn ?? null}, waits_on_json),
          parent_task_id = CASE
            WHEN ${setParent} = 1 THEN ${input.parentTaskId ?? null}
            ELSE parent_task_id
          END,
          lead_thread_id = COALESCE(${input.leadThreadId ?? null}, lead_thread_id),
          location = COALESCE(${input.location ?? null}, location),
          pr_url = COALESCE(${input.prUrl ?? null}, pr_url),
          plan_summary = COALESCE(${input.planSummary ?? null}, plan_summary),
          result_summary = COALESCE(${input.resultSummary ?? null}, result_summary),
          last_outcome = COALESCE(${input.lastOutcome ?? null}, last_outcome),
          updated_at = ${input.now}
        WHERE task_id = ${input.id}
        RETURNING ${taskColumns}
      `;
    },
  });
  const updateTaskReview = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectTaskId,
      review: ReviewJson,
      startsIterateRound: Schema.Boolean,
      now: IsoDateTime,
    }),
    Result: TaskRow,
    execute: ({ id, review, startsIterateRound, now }) => sql`
      UPDATE project_tasks SET
        review_json = ${review},
        iterate_round = iterate_round + ${startsIterateRound ? 1 : 0},
        ready_json = NULL,
        updated_at = ${now}
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskReady = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, ready: ReadyJson, now: IsoDateTime }),
    Result: TaskRow,
    execute: ({ id, ready, now }) => sql`
      UPDATE project_tasks SET
        ready_json = ${ready},
        updated_at = ${now}
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const reopenShipRoundRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, now: IsoDateTime }),
    Result: TaskRow,
    execute: ({ id, now }) => sql`
      UPDATE project_tasks SET
        ship_round = ship_round + 1,
        ready_json = NULL,
        updated_at = ${now}
      WHERE task_id = ${id} AND stage = 'in_review'
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskMove = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectTaskId,
      moveTarget: Schema.NullOr(ExecutionLocation),
      location: Schema.NullOr(ExecutionLocation),
      checkExpected: Schema.Boolean,
      expectedMoveTarget: Schema.NullOr(ExecutionLocation),
      now: IsoDateTime,
    }),
    Result: TaskRow,
    execute: (input) => sql`
      UPDATE project_tasks SET
        move_target = ${input.moveTarget},
        location = COALESCE(${input.location}, location),
        updated_at = ${input.now}
      WHERE task_id = ${input.id}
        AND (${input.checkExpected ? 1 : 0} = 0 OR move_target IS ${input.expectedMoveTarget})
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskMemoryHold = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectTaskId,
      memoryHold: Schema.NullOr(ProjectTaskMemoryHold),
      now: IsoDateTime,
    }),
    Result: TaskRow,
    // Clearing the hold ends its stall, adding the time it held work back.
    execute: (input) => sql`
      UPDATE project_tasks SET
        metrics_json = CASE
          WHEN ${input.memoryHold} IS NULL THEN ${metricsWithMemoryStall(input.now)}
          ELSE metrics_json
        END,
        memory_stall_since = CASE
          WHEN ${input.memoryHold} IS NULL THEN NULL
          ELSE memory_stall_since
        END,
        memory_hold = ${input.memoryHold},
        updated_at = ${input.now}
      WHERE task_id = ${input.id}
      RETURNING ${taskColumns}
    `,
  });
  const startTaskMemoryStall = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, since: IsoDateTime, localOnly: Schema.Boolean }),
    Result: TaskRow,
    // A stall already running keeps its start; a task not held, or finished, cannot stall.
    execute: ({ id, since, localOnly }) => sql`
      UPDATE project_tasks SET
        memory_stall_local_only = CASE
          WHEN memory_stall_since IS NULL THEN ${localOnly ? 1 : 0}
          ELSE memory_stall_local_only
        END,
        memory_stall_since = COALESCE(memory_stall_since, ${since})
      WHERE task_id = ${id}
        AND memory_hold IS NOT NULL
        AND stage NOT IN ('done', 'cancelled')
      RETURNING ${taskColumns}
    `,
  });
  const stopTaskMemoryStall = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, now: IsoDateTime }),
    Result: TaskRow,
    execute: ({ id, now }) => sql`
      UPDATE project_tasks SET
        metrics_json = ${metricsWithMemoryStall(now)},
        memory_stall_since = NULL
      WHERE task_id = ${id} AND memory_stall_since IS NOT NULL
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskHold = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, hold: HoldJson, now: IsoDateTime }),
    Result: TaskRow,
    execute: ({ id, hold, now }) => sql`
      UPDATE project_tasks SET
        hold_json = ${hold},
        updated_at = ${now}
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const stallColumns = sql.literal(`
    stall_id AS "stallId",
    task_id AS "taskId",
    cause AS "cause",
    started_at AS "startedAt",
    woke_at AS "wokeAt",
    notified_at AS "notifiedAt",
    ended_at AS "endedAt"
  `);
  const insertTaskStall = SqlSchema.void({
    Request: Schema.Struct({
      stallId: Schema.String,
      taskId: ProjectTaskId,
      cause: ProjectTaskStallCause,
      startedAt: IsoDateTime,
    }),
    // One open stall per task and cause.
    execute: (input) => sql`
      INSERT INTO project_task_stalls (stall_id, task_id, cause, started_at)
      SELECT ${input.stallId}, ${input.taskId}, ${input.cause}, ${input.startedAt}
      WHERE NOT EXISTS (
        SELECT 1 FROM project_task_stalls
        WHERE task_id = ${input.taskId} AND cause = ${input.cause} AND ended_at IS NULL
      )
    `,
  });
  const findOpenTaskStalls = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: Schema.NullOr(ProjectTaskId) }),
    Result: ProjectTaskStallRecord,
    execute: ({ taskId }) => sql`
      SELECT ${stallColumns}
      FROM project_task_stalls
      WHERE ended_at IS NULL AND (${taskId} IS NULL OR task_id = ${taskId})
      ORDER BY started_at ASC
    `,
  });
  const findTaskStalls = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: ProjectTaskStallRecord,
    execute: ({ taskId }) => sql`
      SELECT ${stallColumns}
      FROM project_task_stalls
      WHERE task_id = ${taskId}
      ORDER BY started_at ASC
    `,
  });
  const updateTaskStallMarks = SqlSchema.void({
    Request: Schema.Struct({
      stallId: Schema.String,
      wokeAt: Schema.NullOr(IsoDateTime),
      notifiedAt: Schema.NullOr(IsoDateTime),
    }),
    execute: ({ stallId, wokeAt, notifiedAt }) => sql`
      UPDATE project_task_stalls SET
        woke_at = COALESCE(woke_at, ${wokeAt}),
        notified_at = COALESCE(notified_at, ${notifiedAt})
      WHERE stall_id = ${stallId}
    `,
  });
  const endTaskStall = SqlSchema.void({
    Request: Schema.Struct({ stallId: Schema.String, endedAt: IsoDateTime }),
    execute: ({ stallId, endedAt }) => sql`
      UPDATE project_task_stalls SET ended_at = ${endedAt}
      WHERE stall_id = ${stallId} AND ended_at IS NULL
    `,
  });
  const addAvoidableStall = SqlSchema.void({
    Request: Schema.Struct({
      taskId: ProjectTaskId,
      cause: ProjectTaskStallCause,
      ms: Schema.Number,
    }),
    // json_set needs the parent object, so it is created first when missing.
    execute: ({ taskId, cause, ms }) => sql`
      UPDATE project_tasks SET
        metrics_json = json_set(
          CASE WHEN json_type(metrics_json, '$.avoidableStallMs') = 'object'
            THEN metrics_json
            ELSE json_set(metrics_json, '$.avoidableStallMs', json('{}'))
          END,
          '$.avoidableStallMs.' || ${cause},
          COALESCE(json_extract(metrics_json, '$.avoidableStallMs.' || ${cause}), 0) + ${ms}
        )
      WHERE task_id = ${taskId}
    `,
  });
  const findMemoryHeldTasks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskRow,
    execute: () => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE memory_hold IS NOT NULL
      ORDER BY number ASC
    `,
  });
  const findMovingTasks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskRow,
    execute: () => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE move_target IS NOT NULL
    `,
  });
  const updateTaskRoleModels = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, roleModels: RoleModelsJson, now: IsoDateTime }),
    Result: TaskRow,
    execute: ({ id, roleModels, now }) => sql`
      UPDATE project_tasks SET
        role_models_json = ${roleModels},
        updated_at = ${now}
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskModelStep = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, role: ProjectTaskModelRole, step: ModelStepJson }),
    Result: TaskRow,
    execute: ({ id, role, step }) => sql`
      UPDATE project_tasks SET
        model_steps_json = json_set(model_steps_json, ${`$.${role}`}, json(${step}))
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const findTaskSessionByThread = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ProjectTaskSession,
    execute: ({ threadId }) => sql`
      SELECT
        task_id AS "taskId",
        thread_id AS "threadId",
        role AS "role",
        created_at AS "createdAt"
      FROM project_task_sessions
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
  });
  const insertModelRun = SqlSchema.findAll({
    Request: Schema.Struct({
      taskId: ProjectTaskId,
      threadId: ThreadId,
      role: ProjectTaskModelRole,
      providerInstanceId: Schema.String,
      model: Schema.NullOr(Schema.String),
      startedAt: IsoDateTime,
    }),
    Result: Schema.Struct({ taskId: ProjectTaskId }),
    execute: ({ taskId, threadId, role, providerInstanceId, model, startedAt }) => sql`
      INSERT INTO project_task_model_runs (
        task_id, thread_id, role, provider_instance_id, model, started_at
      )
      VALUES (${taskId}, ${threadId}, ${role}, ${providerInstanceId}, ${model}, ${startedAt})
      ON CONFLICT (task_id, thread_id) DO NOTHING
      RETURNING task_id AS "taskId"
    `,
  });
  const modelRunColumns = sql.literal(`
    task_id AS "taskId",
    thread_id AS "threadId",
    role AS "role",
    provider_instance_id AS "providerInstanceId",
    model AS "model",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    duration_ms AS "durationMs",
    run_count AS "runCount",
    input_tokens AS "inputTokens",
    cached_input_tokens AS "cachedInputTokens",
    output_tokens AS "outputTokens",
    cost_usd AS "costUsd"
  `);
  const findModelRunByThread = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ProjectTaskModelRun,
    execute: ({ threadId }) => sql`
      SELECT ${modelRunColumns}
      FROM project_task_model_runs
      WHERE thread_id = ${threadId}
      ORDER BY started_at DESC
      LIMIT 1
    `,
  });
  const updateModelRunUsage = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ThreadId,
      durationMs: NonNegativeInt,
      inputTokens: NonNegativeInt,
      cachedInputTokens: NonNegativeInt,
      outputTokens: NonNegativeInt,
      costUsd: Schema.NullOr(Schema.Number),
      finishedAt: IsoDateTime,
    }),
    Result: Schema.Struct({ taskId: ProjectTaskId }),
    execute: (input) => sql`
      UPDATE project_task_model_runs SET
        duration_ms = duration_ms + ${input.durationMs},
        run_count = run_count + 1,
        input_tokens = input_tokens + ${input.inputTokens},
        cached_input_tokens = cached_input_tokens + ${input.cachedInputTokens},
        output_tokens = output_tokens + ${input.outputTokens},
        cost_usd = CASE
          WHEN ${input.costUsd} IS NULL THEN cost_usd
          ELSE COALESCE(cost_usd, 0) + ${input.costUsd}
        END,
        finished_at = ${input.finishedAt}
      WHERE rowid = (
        SELECT rowid FROM project_task_model_runs
        WHERE thread_id = ${input.threadId}
        ORDER BY started_at DESC
        LIMIT 1
      )
      RETURNING task_id AS "taskId"
    `,
  });
  const refreshTaskStepUsage = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId }),
    Result: TaskRow,
    execute: ({ id }) => sql`
      UPDATE project_tasks SET
        step_usage_json = COALESCE((
          SELECT json_group_object(
            role,
            json_object(
              'durationMs', duration_ms,
              'runs', runs,
              'inputTokens', input_tokens,
              'outputTokens', output_tokens,
              'costUsd', cost_usd
            )
          )
          FROM (
            SELECT
              role,
              SUM(duration_ms) AS duration_ms,
              SUM(run_count) AS runs,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_usd) AS cost_usd
            FROM project_task_model_runs
            WHERE task_id = ${id} AND run_count > 0
            GROUP BY role
          )
        ), '{}')
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskMetric = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectTaskId,
      path: Schema.String,
      by: Schema.Int,
    }),
    Result: TaskRow,
    execute: ({ id, path, by }) => sql`
      UPDATE project_tasks SET
        metrics_json = json_set(
          metrics_json,
          ${path},
          COALESCE(json_extract(metrics_json, ${path}), 0) + ${by}
        )
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const updateTaskSize = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectTaskId, size: ProjectTaskSize, now: IsoDateTime }),
    Result: TaskRow,
    execute: ({ id, size, now }) => sql`
      UPDATE project_tasks SET
        metrics_json = json_set(metrics_json, '$.size', ${size}),
        updated_at = ${now}
      WHERE task_id = ${id}
      RETURNING ${taskColumns}
    `,
  });
  const findChildTasks = SqlSchema.findAll({
    Request: Schema.Struct({ parentTaskId: ProjectTaskId }),
    Result: TaskRow,
    execute: ({ parentTaskId }) => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE parent_task_id = ${parentTaskId}
      ORDER BY number ASC
    `,
  });

  const findTasksWaitingOn = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: TaskRow,
    execute: ({ taskId }) => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE EXISTS (SELECT 1 FROM json_each(waits_on_json) WHERE value = ${taskId})
      ORDER BY created_at ASC
    `,
  });

  // Spec versions and sessions

  const specVersionColumns = sql.literal(`
    task_id AS "taskId",
    version AS "version",
    spec_json AS "spec",
    author AS "author",
    author_thread_id AS "authorThreadId",
    note AS "note",
    created_at AS "createdAt"
  `);
  const insertSpecVersion = SqlSchema.findOne({
    Request: Schema.Struct({
      taskId: ProjectTaskId,
      spec: SpecJson,
      author: ProjectTaskSpecAuthor,
      authorThreadId: Schema.NullOr(ThreadId),
      note: Schema.String,
      createdAt: IsoDateTime,
    }),
    Result: SpecVersionRow,
    execute: ({ taskId, spec, author, authorThreadId, note, createdAt }) => sql`
      INSERT INTO project_task_spec_versions (
        task_id, version, spec_json, author, author_thread_id, note, created_at
      )
      SELECT
        ${taskId}, COALESCE(MAX(version), 0) + 1, ${spec}, ${author}, ${authorThreadId},
        ${note}, ${createdAt}
      FROM project_task_spec_versions
      WHERE task_id = ${taskId}
      RETURNING ${specVersionColumns}
    `,
  });
  const findSpecVersions = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: SpecVersionRow,
    execute: ({ taskId }) => sql`
      SELECT ${specVersionColumns}
      FROM project_task_spec_versions
      WHERE task_id = ${taskId}
      ORDER BY version ASC
    `,
  });
  const findSpecVersion = SqlSchema.findOneOption({
    Request: Schema.Struct({ taskId: ProjectTaskId, version: Schema.Int }),
    Result: SpecVersionRow,
    execute: ({ taskId, version }) => sql`
      SELECT ${specVersionColumns}
      FROM project_task_spec_versions
      WHERE task_id = ${taskId} AND version = ${version}
    `,
  });
  const findLatestSpecVersion = SqlSchema.findOneOption({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: SpecVersionRow,
    execute: ({ taskId }) => sql`
      SELECT ${specVersionColumns}
      FROM project_task_spec_versions
      WHERE task_id = ${taskId}
      ORDER BY version DESC
      LIMIT 1
    `,
  });
  const findLatestSpecVersionNumbers = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: Schema.Struct({ taskId: ProjectTaskId, version: Schema.Number }),
    execute: ({ projectId }) => sql`
      SELECT versions.task_id AS "taskId", MAX(versions.version) AS "version"
      FROM project_task_spec_versions AS versions
      JOIN project_tasks AS tasks ON tasks.task_id = versions.task_id
      WHERE tasks.project_id = ${projectId}
      GROUP BY versions.task_id
    `,
  });
  const insertTaskSession = SqlSchema.void({
    Request: ProjectTaskSession,
    execute: ({ taskId, threadId, role, createdAt }) => sql`
      INSERT INTO project_task_sessions (task_id, thread_id, role, created_at)
      VALUES (${taskId}, ${threadId}, ${role}, ${createdAt})
      ON CONFLICT (task_id, thread_id) DO NOTHING
    `,
  });
  const findTaskSessions = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: ProjectTaskSession,
    execute: ({ taskId }) => sql`
      SELECT
        task_id AS "taskId",
        thread_id AS "threadId",
        role AS "role",
        created_at AS "createdAt"
      FROM project_task_sessions
      WHERE task_id = ${taskId}
      ORDER BY created_at ASC, thread_id ASC
    `,
  });

  const searchTaskRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, pattern: Schema.String, limit: Schema.Int }),
    Result: TaskRow,
    execute: ({ projectId, pattern, limit }) => sql`
      SELECT ${taskColumns}
      FROM project_tasks
      WHERE project_id = ${projectId}
        AND (
          title LIKE ${pattern} ESCAPE '\\'
          OR request LIKE ${pattern} ESCAPE '\\'
          OR plan_summary LIKE ${pattern} ESCAPE '\\'
          OR result_summary LIKE ${pattern} ESCAPE '\\'
        )
      ORDER BY updated_at DESC, number DESC
      LIMIT ${limit}
    `,
  });

  // Events

  const insertEvent = SqlSchema.findOne({
    Request: ProjectTaskEvent,
    Result: ProjectTaskEvent,
    execute: (event) => sql`
      INSERT INTO project_task_events (
        event_id, project_id, task_id, kind, body, actor_thread_id, created_at
      )
      VALUES (
        ${event.id}, ${event.projectId}, ${event.taskId}, ${event.kind}, ${event.body},
        ${event.actorThreadId}, ${event.createdAt}
      )
      RETURNING ${eventColumns}
    `,
  });
  const findTaskEvents = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId, limit: Schema.Int }),
    Result: ProjectTaskEvent,
    execute: ({ taskId, limit }) => sql`
      SELECT * FROM (
        SELECT ${eventColumns}, rowid AS "sequence"
        FROM project_task_events
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${limit}
      )
      ORDER BY "createdAt" ASC, "sequence" ASC
    `,
  });
  const findLatestEventByActor = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, actorThreadId: ThreadId }),
    Result: ProjectTaskEvent,
    execute: ({ projectId, actorThreadId }) => sql`
      SELECT ${eventColumns}
      FROM project_task_events
      WHERE project_id = ${projectId} AND actor_thread_id = ${actorThreadId}
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  });

  const findProjectEventsSince = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, since: IsoDateTime }),
    Result: ProjectTaskEvent,
    execute: ({ projectId, since }) => sql`
      SELECT ${eventColumns}
      FROM project_task_events
      WHERE project_id = ${projectId} AND created_at > ${since}
      ORDER BY created_at ASC, rowid ASC
    `,
  });

  const findRecentTaskEndings = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, limit: Schema.Int }),
    Result: ProjectTaskEvent,
    execute: ({ projectId, limit }) => sql`
      SELECT ${eventColumns}
      FROM project_task_events
      WHERE project_id = ${projectId}
        AND (
          (kind = 'stage_changed' AND body LIKE '% → done')
          OR (kind = 'outcome' AND body LIKE 'failed%')
          OR (kind = 'summary' AND body LIKE 'Plan: %')
        )
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit}
    `,
  });

  // Attention items

  const insertAttention = SqlSchema.findOne({
    Request: Schema.Struct({
      id: ProjectAttentionItemId,
      projectId: ProjectId,
      taskId: Schema.NullOr(ProjectTaskId),
      kind: ProjectAttentionKind,
      question: Schema.String,
      options: OptionsJson,
      askerThreadId: Schema.NullOr(ThreadId),
      batchId: ProjectAttentionBatchId,
      createdAt: IsoDateTime,
      specVersion: Schema.NullOr(PositiveInt),
      summary: Schema.NullOr(Schema.String),
      verification: Schema.NullOr(Schema.String),
      context: Schema.NullOr(Schema.fromJsonString(ProjectAttentionContext)),
      senderRole: ProjectAttentionItem.fields.senderRole,
      senderName: ProjectAttentionItem.fields.senderName,
      details: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProjectAttentionDetail))),
    }),
    Result: AttentionRow,
    execute: (item) => sql`
      INSERT INTO project_attention_items (
        item_id, project_id, task_id, kind, question, options_json,
        asker_thread_id, batch_id, created_at, spec_version, summary, verification, context_json, details_json, sender_role, sender_name
      )
      VALUES (
        ${item.id}, ${item.projectId}, ${item.taskId}, ${item.kind}, ${item.question},
        ${item.options}, ${item.askerThreadId}, ${item.batchId}, ${item.createdAt},
        ${item.specVersion}, ${item.summary}, ${item.verification}, ${item.context}, ${item.details}, ${item.senderRole}, ${item.senderName}
      )
      RETURNING ${attentionColumns}
    `,
  });
  const findAttention = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectAttentionItemId }),
    Result: AttentionRow,
    execute: ({ id }) =>
      sql`SELECT ${attentionColumns} FROM project_attention_items WHERE item_id = ${id}`,
  });
  const answerAttentionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectAttentionItemId,
      answer: Schema.String,
      answeredAt: IsoDateTime,
      answeredBy: ProjectAttentionAnsweredBy,
    }),
    Result: AttentionRow,
    execute: ({ id, answer, answeredAt, answeredBy }) => sql`
      UPDATE project_attention_items
      SET answer = ${answer}, answered_at = ${answeredAt}, answered_by = ${answeredBy}
      WHERE item_id = ${id} AND answered_at IS NULL AND superseded_at IS NULL
      RETURNING ${attentionColumns}
    `,
  });
  const supersedeAttentionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectAttentionItemId, supersededAt: IsoDateTime }),
    Result: AttentionRow,
    execute: ({ id, supersededAt }) => sql`
      UPDATE project_attention_items
      SET superseded_at = ${supersededAt}
      WHERE item_id = ${id} AND answered_at IS NULL AND superseded_at IS NULL
      RETURNING ${attentionColumns}
    `,
  });
  const supersedeAttentionRows = SqlSchema.findAll({
    Request: Schema.Struct({
      taskId: ProjectTaskId,
      kind: Schema.optional(ProjectAttentionKind),
      supersededAt: IsoDateTime,
    }),
    Result: AttentionRow,
    execute: ({ taskId, kind, supersededAt }) => sql`
      UPDATE project_attention_items
      SET superseded_at = ${supersededAt}
      WHERE ${sql.and([
        sql`task_id = ${taskId}`,
        ...(kind === undefined ? [] : [sql`kind = ${kind}`]),
        sql`answered_at IS NULL`,
        sql`superseded_at IS NULL`,
      ])}
      RETURNING ${attentionColumns}
    `,
  });
  const findOpenAttention = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, taskId: Schema.optional(ProjectTaskId) }),
    Result: AttentionRow,
    execute: ({ projectId, taskId }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE ${sql.and([
        sql`project_id = ${projectId}`,
        sql`answered_at IS NULL`,
        sql`superseded_at IS NULL`,
        ...(taskId === undefined ? [] : [sql`task_id = ${taskId}`]),
      ])}
      ORDER BY created_at ASC, rowid ASC
    `,
  });
  const findAttentionSince = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, since: IsoDateTime }),
    Result: AttentionRow,
    execute: ({ projectId, since }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE project_id = ${projectId} AND created_at > ${since}
      ORDER BY created_at ASC, rowid ASC
    `,
  });
  const findRecentlyAnswered = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, limit: Schema.Int }),
    Result: AttentionRow,
    execute: ({ projectId, limit }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE project_id = ${projectId} AND answered_at IS NOT NULL
      ORDER BY answered_at DESC, rowid DESC
      LIMIT ${limit}
    `,
  });
  const findAnsweredTaskAttention = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId, kind: ProjectAttentionKind }),
    Result: AttentionRow,
    execute: ({ taskId, kind }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE task_id = ${taskId} AND kind = ${kind} AND answered_at IS NOT NULL
      ORDER BY answered_at ASC, rowid ASC
    `,
  });
  const findRecentAttention = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, limit: Schema.Int }),
    Result: AttentionRow,
    execute: ({ projectId, limit }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE project_id = ${projectId}
        AND (answered_at IS NOT NULL OR superseded_at IS NOT NULL)
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit}
    `,
  });
  const findLatestAttention = SqlSchema.findOneOption({
    Request: ProjectIdRequest,
    Result: AttentionRow,
    execute: ({ projectId }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  });

  const findAnsweredProjectAttention = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, kind: ProjectAttentionKind }),
    Result: AttentionRow,
    execute: ({ projectId, kind }) => sql`
      SELECT ${attentionColumns}
      FROM project_attention_items
      WHERE project_id = ${projectId} AND kind = ${kind} AND answered_at IS NOT NULL
      ORDER BY answered_at ASC, rowid ASC
    `,
  });

  // Corrections

  const correctionColumns = sql.literal(`
    correction_id AS "id",
    project_id AS "projectId",
    task_id AS "taskId",
    kind AS "kind",
    stage AS "stage",
    work_kind AS "workKind",
    user_text AS "userText",
    what_differed AS "whatDiffered",
    source_key AS "sourceKey",
    backfilled AS "backfilled",
    created_at AS "createdAt"
  `);
  const insertCorrectionRow = SqlSchema.findAll({
    Request: ProjectCorrection,
    Result: CorrectionRow,
    execute: (row) => sql`
      INSERT INTO project_corrections (
        correction_id, project_id, task_id, kind, stage, work_kind, user_text,
        what_differed, source_key, backfilled, created_at
      ) VALUES (
        ${row.id}, ${row.projectId}, ${row.taskId}, ${row.kind}, ${row.stage}, ${row.workKind},
        ${row.userText}, ${row.whatDiffered}, ${row.sourceKey}, ${row.backfilled ? 1 : 0},
        ${row.createdAt}
      )
      ON CONFLICT (source_key) DO NOTHING
      RETURNING ${correctionColumns}
    `,
  });
  const findCorrectionBySource = SqlSchema.findOne({
    Request: Schema.Struct({ sourceKey: Schema.String }),
    Result: CorrectionRow,
    execute: ({ sourceKey }) => sql`
      SELECT ${correctionColumns} FROM project_corrections WHERE source_key = ${sourceKey}
    `,
  });
  const findCorrectionsStartedAt = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ value: IsoDateTime }),
    execute: () => sql`
      SELECT value FROM project_correction_state WHERE key = 'recording_started_at'
    `,
  });
  const findCorrections = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.NullOr(ProjectId),
      since: Schema.NullOr(IsoDateTime),
    }),
    Result: CorrectionRow,
    execute: ({ projectId, since }) => sql`
      SELECT ${correctionColumns} FROM project_corrections
      WHERE (${projectId} IS NULL OR project_id = ${projectId})
        AND (${since} IS NULL OR created_at >= ${since})
      ORDER BY created_at ASC, rowid ASC
    `,
  });

  // Memory

  const findMemory = SqlSchema.findAll({
    Request: ProjectIdRequest,
    Result: ProjectMemoryEntry,
    execute: ({ projectId }) => sql`
      SELECT ${memoryColumns} FROM project_memory WHERE project_id = ${projectId} ORDER BY topic ASC
    `,
  });
  const upsertMemoryRow = SqlSchema.findOne({
    Request: ProjectMemoryEntry,
    Result: ProjectMemoryEntry,
    execute: (entry) => sql`
      INSERT INTO project_memory (entry_id, project_id, topic, content, updated_at)
      VALUES (${entry.id}, ${entry.projectId}, ${entry.topic}, ${entry.content}, ${entry.updatedAt})
      ON CONFLICT (project_id, topic) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
      RETURNING ${memoryColumns}
    `,
  });
  const deleteMemoryRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, topic: Schema.String }),
    Result: IdRow,
    execute: ({ projectId, topic }) => sql`
      DELETE FROM project_memory
      WHERE project_id = ${projectId} AND topic = ${topic}
      RETURNING entry_id AS "id"
    `,
  });

  // Workspace goals

  const GoalRow = Schema.Struct({
    id: WorkspaceGoalId,
    title: Schema.String,
    detail: Schema.NullOr(Schema.String),
    status: WorkspaceGoalStatus,
    position: Schema.Int,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  });
  const GoalLinkRow = Schema.Struct({ goalId: WorkspaceGoalId, ...WorkspaceGoalLink.fields });
  const findGoals = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GoalRow,
    execute: () => sql`
      SELECT goal_id AS "id", title, detail, status, position,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM workspace_goals
      ORDER BY position ASC, created_at ASC
    `,
  });
  const findGoalLinks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GoalLinkRow,
    execute: () => sql`
      SELECT goal_id AS "goalId", project_id AS "projectId", task_id AS "taskId"
      FROM workspace_goal_links
      ORDER BY created_at ASC, rowid ASC
    `,
  });
  const upsertGoalRow = SqlSchema.void({
    Request: GoalRow,
    execute: (goal) => sql`
      INSERT INTO workspace_goals (goal_id, title, detail, status, position, created_at, updated_at)
      VALUES (${goal.id}, ${goal.title}, ${goal.detail}, ${goal.status}, ${goal.position},
        ${goal.createdAt}, ${goal.updatedAt})
      ON CONFLICT (goal_id) DO UPDATE SET
        title = excluded.title,
        detail = excluded.detail,
        status = excluded.status,
        position = excluded.position,
        updated_at = excluded.updated_at
    `,
  });
  const deleteGoalLinks = SqlSchema.void({
    Request: Schema.Struct({ goalId: WorkspaceGoalId }),
    execute: ({ goalId }) => sql`DELETE FROM workspace_goal_links WHERE goal_id = ${goalId}`,
  });
  const insertGoalLink = SqlSchema.void({
    Request: Schema.Struct({ ...GoalLinkRow.fields, createdAt: IsoDateTime }),
    execute: (link) => sql`
      INSERT OR IGNORE INTO workspace_goal_links (goal_id, project_id, task_id, created_at)
      VALUES (${link.goalId}, ${link.projectId}, ${link.taskId}, ${link.createdAt})
    `,
  });

  // Sitreps

  const insertSitrep = SqlSchema.findOne({
    Request: Schema.Struct({
      id: ProjectSitrepId,
      projectId: ProjectId,
      since: Schema.NullOr(IsoDateTime),
      reason: ProjectSitrepReason,
      createdAt: IsoDateTime,
    }),
    Result: ProjectSitrep,
    execute: (sitrep) => sql`
      INSERT INTO project_sitreps (sitrep_id, project_id, since, reason, created_at)
      VALUES (${sitrep.id}, ${sitrep.projectId}, ${sitrep.since}, ${sitrep.reason}, ${sitrep.createdAt})
      RETURNING ${sitrepColumns}
    `,
  });
  const setSitrepBodyRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: ProjectSitrepId, body: Schema.String }),
    Result: ProjectSitrep,
    execute: ({ id, body }) => sql`
      UPDATE project_sitreps SET body = ${body} WHERE sitrep_id = ${id} RETURNING ${sitrepColumns}
    `,
  });
  const markSitrepsReadRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, readAt: IsoDateTime }),
    Result: IdRow,
    execute: ({ projectId, readAt }) => sql`
      UPDATE project_sitreps
      SET read_at = ${readAt}
      WHERE project_id = ${projectId} AND body IS NOT NULL AND read_at IS NULL
      RETURNING sitrep_id AS "id"
    `,
  });
  const findLatestSitrep = SqlSchema.findOneOption({
    Request: ProjectIdRequest,
    Result: ProjectSitrep,
    execute: ({ projectId }) => sql`
      SELECT ${sitrepColumns}
      FROM project_sitreps
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  });
  const findLatestPostedSitrep = SqlSchema.findOneOption({
    Request: ProjectIdRequest,
    Result: ProjectSitrep,
    execute: ({ projectId }) => sql`
      SELECT ${sitrepColumns}
      FROM project_sitreps
      WHERE project_id = ${projectId} AND body IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
  });
  const findRecentPostedSitreps = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, limit: Schema.Int }),
    Result: ProjectSitrep,
    execute: ({ projectId, limit }) => sql`
      SELECT ${sitrepColumns}
      FROM project_sitreps
      WHERE project_id = ${projectId} AND body IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit}
    `,
  });
  const countUnreadSitrepRows = SqlSchema.findOne({
    Request: ProjectIdRequest,
    Result: CountRow,
    execute: ({ projectId }) => sql`
      SELECT COUNT(*) AS "count"
      FROM project_sitreps
      WHERE project_id = ${projectId} AND body IS NOT NULL AND read_at IS NULL
    `,
  });

  return ProjectTeamRepository.of({
    getManager: (projectId) =>
      findManager({ projectId }).pipe(Effect.mapError(toRepositoryError("getManager"))),
    getManagerByThreadId: (threadId) =>
      findManagerByThread({ threadId }).pipe(
        Effect.mapError(toRepositoryError("getManagerByThreadId")),
      ),
    listManagers: () => findManagers({}).pipe(Effect.mapError(toRepositoryError("listManagers"))),
    upsertManager: (input) =>
      upsertManagerRow({ ...input, kind: input.kind ?? "pm" }).pipe(
        Effect.mapError(toRepositoryError("upsertManager")),
      ),
    deleteManager: (projectId) =>
      deleteManagerRow({ projectId }).pipe(Effect.mapError(toRepositoryError("deleteManager"))),
    updateManagerSettings: (input) =>
      updateManagerSettingsRow(input).pipe(
        Effect.mapError(toRepositoryError("updateManagerSettings")),
      ),
    recordUserMessage: (input) =>
      recordUserMessageRow(input).pipe(Effect.mapError(toRepositoryError("recordUserMessage"))),
    recordSitrepPosted: (input) =>
      recordSitrepPostedRow(input).pipe(Effect.mapError(toRepositoryError("recordSitrepPosted"))),
    setUnreadSitrepStreak: (input) =>
      setUnreadSitrepStreakRow(input).pipe(
        Effect.mapError(toRepositoryError("setUnreadSitrepStreak")),
      ),

    createTask: (input) =>
      Effect.gen(function* () {
        const task = yield* insertTask({
          id: input.id,
          projectId: input.projectId,
          title: input.title,
          request: input.request,
          waitsOn: input.waitsOn,
          parentTaskId: input.parentTaskId ?? null,
          now: input.now,
        });
        yield* insertSpecVersion({
          taskId: task.id,
          spec: input.spec ?? emptyProjectTaskSpec(input.request),
          author: input.author ?? "pm",
          authorThreadId: input.authorThreadId ?? null,
          note: "Created",
          createdAt: input.now,
        });
        return task;
      }).pipe(sql.withTransaction, Effect.mapError(toRepositoryError("createTask"))),
    getTask: (id) => findTask({ id }).pipe(Effect.mapError(toRepositoryError("getTask"))),
    listTasks: ({ projectId, stages }) =>
      stages !== undefined && stages.length === 0
        ? Effect.succeed([])
        : findTasks({ projectId, ...(stages === undefined ? {} : { stages }) }).pipe(
            Effect.mapError(toRepositoryError("listTasks")),
          ),
    findTaskByLeadThreadId: (threadId) =>
      findTaskByLead({ threadId }).pipe(
        Effect.mapError(toRepositoryError("findTaskByLeadThreadId")),
      ),
    listChildTasks: (parentTaskId) =>
      findChildTasks({ parentTaskId }).pipe(Effect.mapError(toRepositoryError("listChildTasks"))),
    listTasksWaitingOn: (taskId) =>
      findTasksWaitingOn({ taskId }).pipe(Effect.mapError(toRepositoryError("listTasksWaitingOn"))),
    listSpecVersions: (taskId) =>
      findSpecVersions({ taskId }).pipe(Effect.mapError(toRepositoryError("listSpecVersions"))),
    getSpecVersion: (input) =>
      findSpecVersion(input).pipe(Effect.mapError(toRepositoryError("getSpecVersion"))),
    getLatestSpecVersion: (taskId) =>
      findLatestSpecVersion({ taskId }).pipe(
        Effect.mapError(toRepositoryError("getLatestSpecVersion")),
      ),
    listLatestSpecVersionNumbers: (projectId) =>
      findLatestSpecVersionNumbers({ projectId }).pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.taskId, row.version]))),
        Effect.mapError(toRepositoryError("listLatestSpecVersionNumbers")),
      ),
    appendSpecVersion: (input) =>
      insertSpecVersion(input).pipe(Effect.mapError(toRepositoryError("appendSpecVersion"))),
    addTaskSession: (input) =>
      insertTaskSession(input).pipe(Effect.mapError(toRepositoryError("addTaskSession"))),
    listTaskSessions: (taskId) =>
      findTaskSessions({ taskId }).pipe(Effect.mapError(toRepositoryError("listTaskSessions"))),
    updateTask: (input) =>
      updateTaskRow(input).pipe(Effect.mapError(toRepositoryError("updateTask"))),
    recordTaskReview: (input) =>
      updateTaskReview(input).pipe(Effect.mapError(toRepositoryError("recordTaskReview"))),
    setTaskReady: (input) =>
      updateTaskReady(input).pipe(Effect.mapError(toRepositoryError("setTaskReady"))),
    reopenShipRound: (input) =>
      reopenShipRoundRow(input).pipe(Effect.mapError(toRepositoryError("reopenShipRound"))),
    setTaskMove: (input) =>
      updateTaskMove({
        id: input.id,
        moveTarget: input.moveTarget,
        location: input.location ?? null,
        checkExpected: input.expectedMoveTarget !== undefined,
        expectedMoveTarget: input.expectedMoveTarget ?? null,
        now: input.now,
      }).pipe(Effect.mapError(toRepositoryError("setTaskMove"))),
    listMovingTasks: () =>
      findMovingTasks(undefined).pipe(Effect.mapError(toRepositoryError("listMovingTasks"))),
    setTaskMemoryHold: (input) =>
      updateTaskMemoryHold(input).pipe(Effect.mapError(toRepositoryError("setTaskMemoryHold"))),
    setTaskMemoryStall: (input) =>
      (input.stalling
        ? startTaskMemoryStall({
            id: input.id,
            since: input.at,
            localOnly: input.localOnly ?? false,
          })
        : stopTaskMemoryStall({ id: input.id, now: input.at })
      ).pipe(Effect.mapError(toRepositoryError("setTaskMemoryStall"))),
    setTaskHold: (input) =>
      updateTaskHold(input).pipe(Effect.mapError(toRepositoryError("setTaskHold"))),
    openTaskStall: (input) =>
      Effect.gen(function* () {
        yield* insertTaskStall(input);
        const open = yield* findOpenTaskStalls({ taskId: input.taskId });
        return open.find((stall) => stall.cause === input.cause)!;
      }).pipe(Effect.mapError(toRepositoryError("openTaskStall"))),
    listTaskStalls: (input) =>
      findTaskStalls(input).pipe(Effect.mapError(toRepositoryError("listTaskStalls"))),
    listOpenTaskStalls: (input) =>
      findOpenTaskStalls({ taskId: input.taskId ?? null }).pipe(
        Effect.mapError(toRepositoryError("listOpenTaskStalls")),
      ),
    markTaskStall: (input) =>
      updateTaskStallMarks({
        stallId: input.stallId,
        wokeAt: input.wokeAt ?? null,
        notifiedAt: input.notifiedAt ?? null,
      }).pipe(Effect.mapError(toRepositoryError("markTaskStall"))),
    closeTaskStalls: (input) =>
      Effect.gen(function* () {
        const open = yield* findOpenTaskStalls({ taskId: input.taskId });
        const endedMs = Date.parse(input.endedAt);
        for (const stall of open) {
          yield* endTaskStall({ stallId: stall.stallId, endedAt: input.endedAt });
          const ms = Math.max(0, endedMs - Date.parse(stall.startedAt));
          yield* addAvoidableStall({ taskId: stall.taskId, cause: stall.cause, ms });
        }
        return open.map((stall) => ({ ...stall, endedAt: input.endedAt }));
      }).pipe(sql.withTransaction, Effect.mapError(toRepositoryError("closeTaskStalls"))),
    listMemoryHeldTasks: () =>
      findMemoryHeldTasks(undefined).pipe(
        Effect.mapError(toRepositoryError("listMemoryHeldTasks")),
      ),
    setTaskRoleModels: (input) =>
      updateTaskRoleModels(input).pipe(Effect.mapError(toRepositoryError("setTaskRoleModels"))),
    recordModelStep: (input) =>
      updateTaskModelStep(input).pipe(Effect.mapError(toRepositoryError("recordModelStep"))),
    findTaskSessionByThreadId: (threadId) =>
      findTaskSessionByThread({ threadId }).pipe(
        Effect.mapError(toRepositoryError("findTaskSessionByThreadId")),
      ),
    startModelRun: ({ countsFixRound, ...input }) =>
      Effect.gen(function* () {
        const opened = (yield* insertModelRun(input)).length > 0;
        // Counted with the insert, so a fix round is never lost or counted twice.
        if (opened && countsFixRound === true) {
          yield* updateTaskMetric({ id: input.taskId, path: "$.fixRounds", by: 1 });
        }
        return opened;
      }).pipe(sql.withTransaction, Effect.mapError(toRepositoryError("startModelRun"))),
    findModelRunByThreadId: (threadId) =>
      findModelRunByThread({ threadId }).pipe(
        Effect.mapError(toRepositoryError("findModelRunByThreadId")),
      ),
    addModelRunUsage: (input) =>
      updateModelRunUsage({
        ...input,
        durationMs: Math.max(0, Math.round(input.durationMs)),
      }).pipe(
        Effect.flatMap((row) =>
          Option.isNone(row)
            ? Effect.succeed(Option.none<ProjectTask>())
            : refreshTaskStepUsage({ id: row.value.taskId }),
        ),
        Effect.mapError(toRepositoryError("addModelRunUsage")),
      ),
    bumpTaskMetric: ({ id, metric, by }) =>
      updateTaskMetric({ id, path: `$.${metric}`, by }).pipe(
        Effect.mapError(toRepositoryError("bumpTaskMetric")),
      ),
    setTaskSize: (input) =>
      updateTaskSize(input).pipe(Effect.mapError(toRepositoryError("setTaskSize"))),
    searchTasks: ({ projectId, query, limit }) =>
      searchTaskRows({ projectId, pattern: `%${escapeLike(query)}%`, limit }).pipe(
        Effect.mapError(toRepositoryError("searchTasks")),
      ),

    appendTaskEvent: (input) =>
      insertEvent(input).pipe(Effect.mapError(toRepositoryError("appendTaskEvent"))),
    listTaskEvents: (input) =>
      findTaskEvents(input).pipe(Effect.mapError(toRepositoryError("listTaskEvents"))),
    getLatestEventByActor: (input) =>
      findLatestEventByActor(input).pipe(
        Effect.mapError(toRepositoryError("getLatestEventByActor")),
      ),
    listProjectEventsSince: (input) =>
      findProjectEventsSince(input).pipe(
        Effect.mapError(toRepositoryError("listProjectEventsSince")),
      ),
    listRecentTaskEndings: (input) =>
      findRecentTaskEndings(input).pipe(
        Effect.mapError(toRepositoryError("listRecentTaskEndings")),
      ),

    createAttentionItem: (input) =>
      insertAttention({
        ...input,
        specVersion: input.specVersion ?? null,
        summary: input.summary ?? null,
        verification: input.verification ?? null,
        context: input.context ?? null,
        details: input.details ?? null,
        senderRole: input.senderRole ?? null,
        senderName: input.senderName ?? null,
      }).pipe(Effect.mapError(toRepositoryError("createAttentionItem"))),
    getAttentionItem: (id) =>
      findAttention({ id }).pipe(Effect.mapError(toRepositoryError("getAttentionItem"))),
    answerAttentionItem: (input) =>
      answerAttentionRow(input).pipe(Effect.mapError(toRepositoryError("answerAttentionItem"))),
    supersedeAttentionItem: (input) =>
      supersedeAttentionRow(input).pipe(
        Effect.mapError(toRepositoryError("supersedeAttentionItem")),
      ),
    supersedeOpenAttentionItems: (input) =>
      supersedeAttentionRows(input).pipe(
        Effect.mapError(toRepositoryError("supersedeOpenAttentionItems")),
      ),
    listRecentClosedAttentionItems: (input) =>
      findRecentAttention(input).pipe(
        Effect.mapError(toRepositoryError("listRecentClosedAttentionItems")),
      ),
    listOpenAttentionItems: (input) =>
      findOpenAttention(input).pipe(Effect.mapError(toRepositoryError("listOpenAttentionItems"))),
    listAttentionItemsSince: (input) =>
      findAttentionSince(input).pipe(Effect.mapError(toRepositoryError("listAttentionItemsSince"))),
    listAnsweredTaskAttentionItems: (input) =>
      findAnsweredTaskAttention(input).pipe(
        Effect.mapError(toRepositoryError("listAnsweredTaskAttentionItems")),
      ),
    listRecentlyAnsweredAttentionItems: (input) =>
      findRecentlyAnswered(input).pipe(
        Effect.mapError(toRepositoryError("listRecentlyAnsweredAttentionItems")),
      ),
    listAnsweredAttentionItems: (input) =>
      findAnsweredProjectAttention(input).pipe(
        Effect.mapError(toRepositoryError("listAnsweredAttentionItems")),
      ),
    getLatestAttentionItem: (projectId) =>
      findLatestAttention({ projectId }).pipe(
        Effect.mapError(toRepositoryError("getLatestAttentionItem")),
      ),

    insertCorrection: (input) =>
      Effect.gen(function* () {
        const [inserted] = yield* insertCorrectionRow(input);
        if (inserted !== undefined) return { inserted: true, correction: toCorrection(inserted) };
        const existing = yield* findCorrectionBySource({ sourceKey: input.sourceKey });
        return { inserted: false, correction: toCorrection(existing) };
      }).pipe(Effect.mapError(toRepositoryError("insertCorrection"))),
    getCorrectionsStartedAt: () =>
      findCorrectionsStartedAt(undefined).pipe(
        Effect.map((row) => row.value),
        Effect.mapError(toRepositoryError("getCorrectionsStartedAt")),
      ),
    listCorrections: (input) =>
      findCorrections({ projectId: input.projectId ?? null, since: input.since ?? null }).pipe(
        Effect.map((rows) => rows.map(toCorrection)),
        Effect.mapError(toRepositoryError("listCorrections")),
      ),

    listMemory: (projectId) =>
      findMemory({ projectId }).pipe(Effect.mapError(toRepositoryError("listMemory"))),
    upsertMemory: (input) =>
      upsertMemoryRow(input).pipe(Effect.mapError(toRepositoryError("upsertMemory"))),
    deleteMemory: (input) =>
      deleteMemoryRows(input).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toRepositoryError("deleteMemory")),
      ),

    listWorkspaceGoals: () =>
      Effect.gen(function* () {
        const goals = yield* findGoals(undefined);
        const links = yield* findGoalLinks(undefined);
        return goals.map((goal): WorkspaceGoal => ({
          ...goal,
          links: links
            .filter((link) => link.goalId === goal.id)
            .map((link) => ({ projectId: link.projectId, taskId: link.taskId })),
        }));
      }).pipe(Effect.mapError(toRepositoryError("listWorkspaceGoals"))),
    saveWorkspaceGoal: ({ links, ...goal }) =>
      Effect.gen(function* () {
        yield* upsertGoalRow(goal);
        yield* deleteGoalLinks({ goalId: goal.id });
        // Links keep their order; the timestamp only breaks ties within one save.
        for (const link of links) {
          yield* insertGoalLink({ goalId: goal.id, ...link, createdAt: goal.updatedAt });
        }
      }).pipe(sql.withTransaction, Effect.mapError(toRepositoryError("saveWorkspaceGoal"))),

    createSitrep: (input) =>
      insertSitrep(input).pipe(Effect.mapError(toRepositoryError("createSitrep"))),
    setSitrepBody: (input) =>
      setSitrepBodyRow(input).pipe(Effect.mapError(toRepositoryError("setSitrepBody"))),
    markSitrepsRead: (input) =>
      markSitrepsReadRows(input).pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(toRepositoryError("markSitrepsRead")),
      ),
    getLatestSitrep: (projectId) =>
      findLatestSitrep({ projectId }).pipe(Effect.mapError(toRepositoryError("getLatestSitrep"))),
    getLatestPostedSitrep: (projectId) =>
      findLatestPostedSitrep({ projectId }).pipe(
        Effect.mapError(toRepositoryError("getLatestPostedSitrep")),
      ),
    listRecentPostedSitreps: (input) =>
      findRecentPostedSitreps(input).pipe(
        Effect.mapError(toRepositoryError("listRecentPostedSitreps")),
      ),
    countUnreadSitreps: (projectId) =>
      countUnreadSitrepRows({ projectId }).pipe(
        Effect.map((row) => row.count),
        Effect.mapError(toRepositoryError("countUnreadSitreps")),
      ),
  });
});

export const layer = Layer.effect(ProjectTeamRepository, make);
