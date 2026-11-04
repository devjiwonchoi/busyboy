import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Project manager state: tasks, their log, attention items, memory and sitreps. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE project_managers (
      project_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      last_user_message_at TEXT,
      last_sitrep_at TEXT,
      unread_sitrep_streak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_project_managers_thread ON project_managers(thread_id)`;

  yield* sql`
    CREATE TABLE project_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      request TEXT NOT NULL,
      stage TEXT NOT NULL,
      waits_on_json TEXT NOT NULL,
      lead_thread_id TEXT,
      pr_url TEXT,
      plan_summary TEXT,
      result_summary TEXT,
      last_outcome TEXT,
      nudge_count INTEGER NOT NULL DEFAULT 0,
      stage_changed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, number)
    )
  `;
  yield* sql`CREATE INDEX idx_project_tasks_stage ON project_tasks(project_id, stage)`;
  yield* sql`CREATE INDEX idx_project_tasks_lead_thread ON project_tasks(lead_thread_id) WHERE lead_thread_id IS NOT NULL`;

  yield* sql`
    CREATE TABLE project_task_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT REFERENCES project_tasks(task_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      actor_thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_project_task_events_task ON project_task_events(task_id, created_at)`;
  yield* sql`CREATE INDEX idx_project_task_events_project ON project_task_events(project_id, created_at)`;

  yield* sql`
    CREATE TABLE project_attention_items (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES project_tasks(task_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      answer TEXT,
      answered_at TEXT,
      asker_thread_id TEXT,
      batch_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_project_attention_items_project ON project_attention_items(project_id, created_at)`;
  yield* sql`CREATE INDEX idx_project_attention_items_open ON project_attention_items(project_id, task_id) WHERE answered_at IS NULL`;

  yield* sql`
    CREATE TABLE project_memory (
      entry_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, topic)
    )
  `;

  yield* sql`
    CREATE TABLE project_sitreps (
      sitrep_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      since TEXT,
      body TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    )
  `;
  yield* sql`CREATE INDEX idx_project_sitreps_project ON project_sitreps(project_id, created_at)`;
});
