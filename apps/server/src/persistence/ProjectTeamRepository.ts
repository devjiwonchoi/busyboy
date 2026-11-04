import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectAttentionBatchId,
  ProjectAttentionItem,
  ProjectAttentionItemId,
  ProjectAttentionKind,
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
  ProjectTaskStage,
  ProjectTeamSettings,
  ThreadId,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  type ProjectTeamRepositoryError,
  toPersistenceSqlError,
} from "./Errors.ts";

export const ProjectManagerRecord = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
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
}

export interface UpdateProjectTaskInput {
  readonly id: ProjectTaskId;
  readonly now: IsoDateTime;
  readonly stage?: ProjectTaskStage;
  readonly waitsOn?: ReadonlyArray<ProjectTaskId>;
  readonly leadThreadId?: ThreadId;
  readonly prUrl?: string;
  readonly planSummary?: string;
  readonly resultSummary?: string;
  readonly lastOutcome?: ProjectTaskOutcome;
  readonly nudgeCount?: number;
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
  readonly taskId: ProjectTaskId;
  readonly kind: ProjectAttentionKind;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly askerThreadId: ThreadId | null;
  readonly batchId: ProjectAttentionBatchId;
  readonly createdAt: IsoDateTime;
}

export interface CreateProjectSitrepInput {
  readonly id: ProjectSitrepId;
  readonly projectId: ProjectId;
  readonly since: IsoDateTime | null;
  readonly reason: ProjectSitrepReason;
  readonly createdAt: IsoDateTime;
}

type Result<A> = Effect.Effect<A, ProjectTeamRepositoryError>;

export class ProjectTeamRepository extends Context.Service<
  ProjectTeamRepository,
  {
    readonly getManager: (projectId: ProjectId) => Result<Option.Option<ProjectManagerRecord>>;
    readonly getManagerByThreadId: (
      threadId: ThreadId,
    ) => Result<Option.Option<ProjectManagerRecord>>;
    readonly listManagers: () => Result<ReadonlyArray<ProjectManagerRecord>>;
    readonly upsertManager: (input: UpsertProjectManagerInput) => Result<ProjectManagerRecord>;
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
    /**
     * Updates the given fields. A stage change also sets stage_changed_at and
     * resets nudge_count to 0, overriding a nudgeCount in the same call.
     */
    readonly updateTask: (input: UpdateProjectTaskInput) => Result<Option.Option<ProjectTask>>;
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
    /** The newest stage changes to done and failed outcomes, newest first. */
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
    /** None when the item does not exist or was already answered. */
    readonly answerAttentionItem: (input: {
      readonly id: ProjectAttentionItemId;
      readonly answer: string;
      readonly answeredAt: IsoDateTime;
    }) => Result<Option.Option<ProjectAttentionItem>>;
    readonly listOpenAttentionItems: (input: {
      readonly projectId: ProjectId;
      readonly taskId?: ProjectTaskId;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    readonly listAttentionItemsSince: (input: {
      readonly projectId: ProjectId;
      readonly since: IsoDateTime;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** The most recently answered items, newest answer first. */
    readonly listRecentlyAnsweredAttentionItems: (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
    }) => Result<ReadonlyArray<ProjectAttentionItem>>;
    /** The newest item, answered or not, for batching. */
    readonly getLatestAttentionItem: (
      projectId: ProjectId,
    ) => Result<Option.Option<ProjectAttentionItem>>;

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

const ManagerRow = Schema.Struct({
  ...ProjectManagerRecord.fields,
  settings: Schema.fromJsonString(ProjectTeamSettings),
});
const TaskRow = Schema.Struct({
  ...ProjectTask.fields,
  waitsOn: Schema.fromJsonString(Schema.Array(ProjectTaskId)),
});
const AttentionRow = Schema.Struct({
  ...ProjectAttentionItem.fields,
  options: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const CountRow = Schema.Struct({ count: NonNegativeInt });
const IdRow = Schema.Struct({ id: Schema.String });

const SettingsJson = Schema.fromJsonString(ProjectTeamSettings);
const WaitsOnJson = Schema.fromJsonString(Schema.Array(ProjectTaskId));
const OptionsJson = Schema.fromJsonString(Schema.Array(Schema.String));

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
    lead_thread_id AS "leadThreadId",
    pr_url AS "prUrl",
    plan_summary AS "planSummary",
    result_summary AS "resultSummary",
    last_outcome AS "lastOutcome",
    nudge_count AS "nudgeCount",
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
    created_at AS "createdAt"
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
      settings: SettingsJson,
      now: IsoDateTime,
    }),
    Result: ManagerRow,
    execute: ({ projectId, threadId, settings, now }) => sql`
      INSERT INTO project_managers (project_id, thread_id, settings_json, created_at, updated_at)
      VALUES (${projectId}, ${threadId}, ${settings}, ${now}, ${now})
      ON CONFLICT (project_id) DO UPDATE SET
        thread_id = excluded.thread_id,
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
      now: IsoDateTime,
    }),
    Result: TaskRow,
    execute: ({ id, projectId, title, request, waitsOn, now }) => sql`
      INSERT INTO project_tasks (
        task_id, project_id, number, title, request, stage, waits_on_json,
        nudge_count, stage_changed_at, created_at, updated_at
      )
      SELECT
        ${id}, ${projectId}, COALESCE(MAX(number), 0) + 1, ${title}, ${request}, 'inbox',
        ${waitsOn}, 0, ${now}, ${now}, ${now}
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
  const updateTaskRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: ProjectTaskId,
      now: IsoDateTime,
      stage: Schema.optional(ProjectTaskStage),
      waitsOn: Schema.optional(WaitsOnJson),
      leadThreadId: Schema.optional(ThreadId),
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
      return sql`
        UPDATE project_tasks SET
          stage = COALESCE(${stage}, stage),
          stage_changed_at = CASE WHEN ${stageChanged} THEN ${input.now} ELSE stage_changed_at END,
          nudge_count = CASE
            WHEN ${stageChanged} THEN 0
            ELSE COALESCE(${input.nudgeCount ?? null}, nudge_count)
          END,
          waits_on_json = COALESCE(${input.waitsOn ?? null}, waits_on_json),
          lead_thread_id = COALESCE(${input.leadThreadId ?? null}, lead_thread_id),
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
      taskId: ProjectTaskId,
      kind: ProjectAttentionKind,
      question: Schema.String,
      options: OptionsJson,
      askerThreadId: Schema.NullOr(ThreadId),
      batchId: ProjectAttentionBatchId,
      createdAt: IsoDateTime,
    }),
    Result: AttentionRow,
    execute: (item) => sql`
      INSERT INTO project_attention_items (
        item_id, project_id, task_id, kind, question, options_json,
        asker_thread_id, batch_id, created_at
      )
      VALUES (
        ${item.id}, ${item.projectId}, ${item.taskId}, ${item.kind}, ${item.question},
        ${item.options}, ${item.askerThreadId}, ${item.batchId}, ${item.createdAt}
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
    }),
    Result: AttentionRow,
    execute: ({ id, answer, answeredAt }) => sql`
      UPDATE project_attention_items
      SET answer = ${answer}, answered_at = ${answeredAt}
      WHERE item_id = ${id} AND answered_at IS NULL
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
      upsertManagerRow(input).pipe(Effect.mapError(toRepositoryError("upsertManager"))),
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

    createTask: (input) => insertTask(input).pipe(Effect.mapError(toRepositoryError("createTask"))),
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
    updateTask: (input) =>
      updateTaskRow(input).pipe(Effect.mapError(toRepositoryError("updateTask"))),
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
      insertAttention(input).pipe(Effect.mapError(toRepositoryError("createAttentionItem"))),
    getAttentionItem: (id) =>
      findAttention({ id }).pipe(Effect.mapError(toRepositoryError("getAttentionItem"))),
    answerAttentionItem: (input) =>
      answerAttentionRow(input).pipe(Effect.mapError(toRepositoryError("answerAttentionItem"))),
    listOpenAttentionItems: (input) =>
      findOpenAttention(input).pipe(Effect.mapError(toRepositoryError("listOpenAttentionItems"))),
    listAttentionItemsSince: (input) =>
      findAttentionSince(input).pipe(Effect.mapError(toRepositoryError("listAttentionItemsSince"))),
    listRecentlyAnsweredAttentionItems: (input) =>
      findRecentlyAnswered(input).pipe(
        Effect.mapError(toRepositoryError("listRecentlyAnsweredAttentionItems")),
      ),
    getLatestAttentionItem: (projectId) =>
      findLatestAttention({ projectId }).pipe(
        Effect.mapError(toRepositoryError("getLatestAttentionItem")),
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
