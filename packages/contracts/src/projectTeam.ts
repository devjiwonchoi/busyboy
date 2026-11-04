import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { OrchestratorMcpTarget } from "./orchestratorMcp.ts";
import { ProjectIconOverride } from "./project.ts";

export const ProjectTaskId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectTaskId"));
export type ProjectTaskId = typeof ProjectTaskId.Type;
export const ProjectTaskEventId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectTaskEventId"));
export type ProjectTaskEventId = typeof ProjectTaskEventId.Type;
export const ProjectAttentionItemId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectAttentionItemId"),
);
export type ProjectAttentionItemId = typeof ProjectAttentionItemId.Type;
export const ProjectAttentionBatchId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectAttentionBatchId"),
);
export type ProjectAttentionBatchId = typeof ProjectAttentionBatchId.Type;
export const ProjectMemoryEntryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectMemoryEntryId"),
);
export type ProjectMemoryEntryId = typeof ProjectMemoryEntryId.Type;
export const ProjectSitrepId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectSitrepId"));
export type ProjectSitrepId = typeof ProjectSitrepId.Type;

export const DEFAULT_PROJECT_TEAM_MAX_CONCURRENT_TASKS = 6;
export const MAX_PROJECT_TEAM_MAX_CONCURRENT_TASKS = 32;
export const DEFAULT_PROJECT_TEAM_SITREP_INTERVAL_MINUTES = 60;
/** Bounds for an interval the user sets directly. */
export const MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES = 5;
export const MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES = 1440;
/** Bounds the server keeps to when it adjusts the interval on its own. */
export const MIN_PROJECT_TEAM_AUTO_SITREP_INTERVAL_MINUTES = 15;
export const MAX_PROJECT_TEAM_AUTO_SITREP_INTERVAL_MINUTES = 480;

export const ProjectTaskStage = Schema.Literals([
  "inbox",
  "planning",
  "running",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);
export type ProjectTaskStage = typeof ProjectTaskStage.Type;

export const ProjectTaskOutcome = Schema.Literals([
  "waiting_user",
  "in_review",
  "done",
  "failed",
  "stalled",
]);
export type ProjectTaskOutcome = typeof ProjectTaskOutcome.Type;

const ProjectTaskTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "Short task title.",
});
const ProjectTaskRequest = TrimmedNonEmptyString.check(Schema.isMaxLength(60_000)).annotate({
  description: "The user's request, complete enough for a task lead to act on alone.",
});
const ProjectTaskSummaryText = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
const ProjectTaskPullRequestUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)).annotate({
  description: "Pull request URL.",
});

export const ProjectTask = Schema.Struct({
  id: ProjectTaskId,
  projectId: ProjectId,
  number: PositiveInt,
  title: Schema.String,
  request: Schema.String,
  stage: ProjectTaskStage,
  waitsOn: Schema.Array(ProjectTaskId),
  leadThreadId: Schema.NullOr(ThreadId),
  prUrl: Schema.NullOr(Schema.String),
  planSummary: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
  lastOutcome: Schema.NullOr(ProjectTaskOutcome),
  nudgeCount: NonNegativeInt,
  stageChangedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectTask = typeof ProjectTask.Type;

/** Compact task row for status and list results. */
export const ProjectTaskBrief = Schema.Struct({
  id: ProjectTaskId,
  number: PositiveInt,
  title: Schema.String,
  stage: ProjectTaskStage,
  lastOutcome: Schema.NullOr(ProjectTaskOutcome),
  leadThreadId: Schema.NullOr(ThreadId),
  prUrl: Schema.NullOr(Schema.String),
  nudgeCount: NonNegativeInt,
  waitsOn: Schema.Array(ProjectTaskId),
  stageChangedAt: IsoDateTime,
});
export type ProjectTaskBrief = typeof ProjectTaskBrief.Type;

export const ProjectTaskEventKind = Schema.Literals([
  "created",
  "stage_changed",
  "outcome",
  "nudge",
  "note",
  "summary",
  "preference_changed",
]);
export type ProjectTaskEventKind = typeof ProjectTaskEventKind.Type;

/** A dated log entry. Project-level entries such as preference_changed have no task. */
export const ProjectTaskEvent = Schema.Struct({
  id: ProjectTaskEventId,
  projectId: ProjectId,
  taskId: Schema.NullOr(ProjectTaskId),
  kind: ProjectTaskEventKind,
  body: Schema.String,
  actorThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type ProjectTaskEvent = typeof ProjectTaskEvent.Type;

export const ProjectAttentionKind = Schema.Literals(["decision", "approval", "blocker"]);
export type ProjectAttentionKind = typeof ProjectAttentionKind.Type;

export const ProjectAttentionItem = Schema.Struct({
  id: ProjectAttentionItemId,
  projectId: ProjectId,
  taskId: ProjectTaskId,
  kind: ProjectAttentionKind,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  answer: Schema.NullOr(Schema.String),
  answeredAt: Schema.NullOr(IsoDateTime),
  /** Thread that receives the answer. Null for server-raised items with no live lead. */
  askerThreadId: Schema.NullOr(ThreadId),
  batchId: ProjectAttentionBatchId,
  createdAt: IsoDateTime,
});
export type ProjectAttentionItem = typeof ProjectAttentionItem.Type;

export const ProjectMemoryEntry = Schema.Struct({
  id: ProjectMemoryEntryId,
  projectId: ProjectId,
  topic: Schema.String,
  content: Schema.String,
  updatedAt: IsoDateTime,
});
export type ProjectMemoryEntry = typeof ProjectMemoryEntry.Type;

const ProjectTeamTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local wall-clock time in 24-hour HH:MM form, such as 22:00." });

export const ProjectTeamQuietHours = Schema.Struct({
  start: ProjectTeamTimeOfDay,
  end: ProjectTeamTimeOfDay,
}).annotate({ description: "Local hours with no sitreps. May wrap past midnight." });
export type ProjectTeamQuietHours = typeof ProjectTeamQuietHours.Type;

const ProjectTeamMaxConcurrentTasks = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_PROJECT_TEAM_MAX_CONCURRENT_TASKS }),
).annotate({ description: "How many task leads may run at once." });

export const ProjectTeamSitrepIntervalMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
    maximum: MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
  }),
).annotate({ description: "Minutes between interval sitreps, 5 to 1440." });

/** Same shape as a project icon, so the icon picker and renderer can be reused. */
export const ProjectManagerAvatar = ProjectIconOverride;
export type ProjectManagerAvatar = typeof ProjectManagerAvatar.Type;

export const ProjectManagerVoice = Schema.Literals(["chill", "dry", "chatty", "custom"]);
export type ProjectManagerVoice = typeof ProjectManagerVoice.Type;

const ProjectManagerName = TrimmedNonEmptyString.check(Schema.isMaxLength(40)).annotate({
  description: "Your display name, up to 40 characters.",
});
const ProjectManagerVoiceCustom = TrimmedString.check(Schema.isMaxLength(500)).annotate({
  description: "How you sound when voice is custom, up to 500 characters.",
});

export const ProjectManagerPersona = Schema.Struct({
  name: ProjectManagerName,
  avatar: ProjectManagerAvatar,
  voice: ProjectManagerVoice,
  voiceCustom: Schema.optionalKey(ProjectManagerVoiceCustom),
});
export type ProjectManagerPersona = typeof ProjectManagerPersona.Type;

export const ProjectTeamSettings = Schema.Struct({
  maxConcurrentTasks: ProjectTeamMaxConcurrentTasks.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_TEAM_MAX_CONCURRENT_TASKS)),
  ),
  sitrepIntervalMinutes: ProjectTeamSitrepIntervalMinutes.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_TEAM_SITREP_INTERVAL_MINUTES)),
  ),
  sitrepNotify: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  quietHours: Schema.optionalKey(ProjectTeamQuietHours),
  /** Set when the user picks values directly; no automatic adjustment until then. */
  pinnedUntil: Schema.optionalKey(IsoDateTime),
  /** Absent until the user or PM picks one; the server resolves a per-project default. */
  persona: Schema.optionalKey(ProjectManagerPersona),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ProjectTeamSettings = typeof ProjectTeamSettings.Type;

export const DEFAULT_PROJECT_TEAM_SETTINGS: ProjectTeamSettings = {
  maxConcurrentTasks: DEFAULT_PROJECT_TEAM_MAX_CONCURRENT_TASKS,
  sitrepIntervalMinutes: DEFAULT_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
  sitrepNotify: true,
  enabled: true,
};

export const ProjectSitrepReason = Schema.Literals([
  "milestone",
  "interval",
  "liveness",
  "requested",
]);
export type ProjectSitrepReason = typeof ProjectSitrepReason.Type;

export const ProjectSitrep = Schema.Struct({
  id: ProjectSitrepId,
  projectId: ProjectId,
  /** Start of the reported window. Null for a project's first sitrep. */
  since: Schema.NullOr(IsoDateTime),
  /** The PM's posted text. Null while the PM is still writing it. */
  body: Schema.NullOr(Schema.String),
  reason: ProjectSitrepReason,
  createdAt: IsoDateTime,
  readAt: Schema.NullOr(IsoDateTime),
});
export type ProjectSitrep = typeof ProjectSitrep.Type;

export const ProjectTeamTasksByStage = Schema.Struct({
  inbox: Schema.Array(ProjectTaskBrief),
  planning: Schema.Array(ProjectTaskBrief),
  running: Schema.Array(ProjectTaskBrief),
  in_review: Schema.Array(ProjectTaskBrief),
  done: Schema.Array(ProjectTaskBrief),
  blocked: Schema.Array(ProjectTaskBrief),
  cancelled: Schema.Array(ProjectTaskBrief),
});
export type ProjectTeamTasksByStage = typeof ProjectTeamTasksByStage.Type;

export const ProjectTeamJournalKind = Schema.Literals(["done", "failed", "decision", "sitrep"]);
export type ProjectTeamJournalKind = typeof ProjectTeamJournalKind.Type;

/** One line of the team's recent history, so a PM can catch up after its context is tidied. */
export const ProjectTeamJournalEntry = Schema.Struct({
  at: IsoDateTime,
  kind: ProjectTeamJournalKind,
  text: Schema.String,
});
export type ProjectTeamJournalEntry = typeof ProjectTeamJournalEntry.Type;

export const ProjectTeamStatus = Schema.Struct({
  projectId: ProjectId,
  tasks: ProjectTeamTasksByStage,
  stalled: Schema.Array(ProjectTaskBrief),
  openAttention: Schema.Array(ProjectAttentionItem),
  settings: ProjectTeamSettings,
  changes: Schema.Struct({
    /** Defaults to the later of the last sitrep and the last user message. */
    since: Schema.NullOr(IsoDateTime),
    done: Schema.Array(ProjectTaskBrief),
    prOpened: Schema.Array(ProjectTaskBrief),
    newAttention: Schema.Array(ProjectAttentionItem),
    blocked: Schema.Array(ProjectTaskBrief),
  }),
  /** Latest done/failed tasks, decisions, and sitreps, newest first. */
  journal: Schema.Array(ProjectTeamJournalEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Topics of the PM's memory entries. */
  memoryTopics: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ProjectTeamStatus = typeof ProjectTeamStatus.Type;

// MCP tool inputs and results.

const ProjectTeamListLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

export const ProjectTeamTaskCreateInput = Schema.Struct({
  title: ProjectTaskTitle,
  request: ProjectTaskRequest,
  waitsOn: Schema.optional(Schema.Array(ProjectTaskId)).annotate({
    description:
      "Tasks that must reach in_review or done before this one starts, such as tasks touching the same files.",
  }),
});
export type ProjectTeamTaskCreateInput = typeof ProjectTeamTaskCreateInput.Type;

export const ProjectTeamTaskResult = Schema.Struct({
  task: ProjectTask,
});
export type ProjectTeamTaskResult = typeof ProjectTeamTaskResult.Type;

export const ProjectTeamTaskStartInput = Schema.Struct({
  taskId: ProjectTaskId,
  target: Schema.optional(OrchestratorMcpTarget).annotate({
    description: "Provider and model for the task lead. Omit to use the PM's own.",
  }),
});
export type ProjectTeamTaskStartInput = typeof ProjectTeamTaskStartInput.Type;

export const ProjectTeamTaskStartResult = Schema.Struct({
  task: ProjectTask,
  leadThreadId: ThreadId,
});
export type ProjectTeamTaskStartResult = typeof ProjectTeamTaskStartResult.Type;

export const ProjectTeamTaskUpdateInput = Schema.Struct({
  taskId: Schema.optional(ProjectTaskId).annotate({
    description: "Task to update. A task lead may omit it to update its own task.",
  }),
  stage: Schema.optional(
    Schema.Literals(["running", "in_review", "done", "blocked", "cancelled"]).annotate({
      description: "New stage.",
    }),
  ),
  planSummary: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "The approved plan, in short.",
  }),
  resultSummary: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "What was delivered.",
  }),
  prUrl: Schema.optional(ProjectTaskPullRequestUrl),
  note: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "Progress note added to the task log.",
  }),
}).check(
  Schema.makeFilter((input) =>
    input.stage !== undefined ||
    input.planSummary !== undefined ||
    input.resultSummary !== undefined ||
    input.prUrl !== undefined ||
    input.note !== undefined
      ? true
      : "task_update needs at least one of stage, planSummary, resultSummary, prUrl or note.",
  ),
);
export type ProjectTeamTaskUpdateInput = typeof ProjectTeamTaskUpdateInput.Type;

export const ProjectTeamTaskNudgeInput = Schema.Struct({
  taskId: ProjectTaskId,
  note: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "What the task lead should do next.",
  }),
});
export type ProjectTeamTaskNudgeInput = typeof ProjectTeamTaskNudgeInput.Type;

export const ProjectTeamTaskNudgeResult = Schema.Struct({
  status: Schema.Literals(["sent", "escalated"]).annotate({
    description:
      "sent: the task lead got the nudge. escalated: the nudge limit was reached and a blocker was raised for the user instead.",
  }),
  task: ProjectTask,
  attentionItem: Schema.NullOr(ProjectAttentionItem),
});
export type ProjectTeamTaskNudgeResult = typeof ProjectTeamTaskNudgeResult.Type;

export const ProjectTeamTaskListInput = Schema.Struct({
  stages: Schema.optional(Schema.Array(ProjectTaskStage)).annotate({
    description: "Only these stages. Omit for all.",
  }),
  limit: Schema.optional(ProjectTeamListLimit),
});
export type ProjectTeamTaskListInput = typeof ProjectTeamTaskListInput.Type;

export const ProjectTeamTaskListResult = Schema.Struct({
  tasks: Schema.Array(ProjectTaskBrief),
});
export type ProjectTeamTaskListResult = typeof ProjectTeamTaskListResult.Type;

export const ProjectTeamTaskReadInput = Schema.Struct({
  taskId: ProjectTaskId,
  eventLimit: Schema.optional(ProjectTeamListLimit).annotate({
    description: "Most recent log entries to include. Defaults to 20.",
  }),
});
export type ProjectTeamTaskReadInput = typeof ProjectTeamTaskReadInput.Type;

export const ProjectTeamTaskReadResult = Schema.Struct({
  task: ProjectTask,
  events: Schema.Array(ProjectTaskEvent),
  openAttention: Schema.Array(ProjectAttentionItem),
});
export type ProjectTeamTaskReadResult = typeof ProjectTeamTaskReadResult.Type;

export const ProjectTeamTaskSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "Text to find in task titles, requests, plans and results.",
  }),
  limit: Schema.optional(ProjectTeamListLimit),
});
export type ProjectTeamTaskSearchInput = typeof ProjectTeamTaskSearchInput.Type;

export const ProjectTeamTaskSearchResult = Schema.Struct({
  tasks: Schema.Array(ProjectTask),
});
export type ProjectTeamTaskSearchResult = typeof ProjectTeamTaskSearchResult.Type;

export const ProjectTeamStatusInput = Schema.Struct({
  since: Schema.optional(IsoDateTime).annotate({
    description:
      "Report changes after this time. Defaults to the later of the last sitrep and the last user message.",
  }),
  reason: Schema.optional(
    Schema.Literal("user_asked").annotate({
      description: "Pass user_asked when the user asked for progress.",
    }),
  ),
});
export type ProjectTeamStatusInput = typeof ProjectTeamStatusInput.Type;

export const ProjectTeamSettingsUpdateInput = Schema.Struct({
  maxConcurrentTasks: Schema.optional(ProjectTeamMaxConcurrentTasks),
  sitrepIntervalMinutes: Schema.optional(ProjectTeamSitrepIntervalMinutes),
  sitrepNotify: Schema.optional(Schema.Boolean).annotate({
    description: "Whether sitreps show a notification.",
  }),
  quietHours: Schema.optional(Schema.NullOr(ProjectTeamQuietHours)).annotate({
    description: "Hours with no sitreps. Null clears them.",
  }),
  name: Schema.optional(ProjectManagerName),
  avatarEmoji: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(16)).annotate({
      description: "A single emoji to use as your avatar.",
    }),
  ),
  voice: Schema.optional(ProjectManagerVoice).annotate({
    description:
      "chill: relaxed and brief. dry: terse and matter-of-fact. chatty: warm and talkative. custom: follow voiceCustom.",
  }),
  voiceCustom: Schema.optional(ProjectManagerVoiceCustom),
}).check(
  Schema.makeFilter((input) =>
    input.maxConcurrentTasks !== undefined ||
    input.sitrepIntervalMinutes !== undefined ||
    input.sitrepNotify !== undefined ||
    input.quietHours !== undefined ||
    input.name !== undefined ||
    input.avatarEmoji !== undefined ||
    input.voice !== undefined ||
    input.voiceCustom !== undefined
      ? true
      : "team_settings_update needs at least one setting.",
  ),
);
export type ProjectTeamSettingsUpdateInput = typeof ProjectTeamSettingsUpdateInput.Type;

export const ProjectTeamSettingsResult = Schema.Struct({
  projectId: ProjectId,
  settings: ProjectTeamSettings,
});
export type ProjectTeamSettingsResult = typeof ProjectTeamSettingsResult.Type;

export const ProjectTeamAskUserInput = Schema.Struct({
  kind: ProjectAttentionKind.annotate({
    description:
      "decision: a choice only the user can make. approval: sign-off on a plan. blocker: something only a person can unblock.",
  }),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)).annotate({
    description: "Self-contained question. For approval, include the plan summary.",
  }),
  options: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
      Schema.isMaxLength(10),
    ),
  ).annotate({ description: "Suggested answers, if any." }),
});
export type ProjectTeamAskUserInput = typeof ProjectTeamAskUserInput.Type;

export const ProjectTeamAttentionItemResult = Schema.Struct({
  item: ProjectAttentionItem,
});
export type ProjectTeamAttentionItemResult = typeof ProjectTeamAttentionItemResult.Type;

export const ProjectTeamAttentionAnswerInput = Schema.Struct({
  attentionItemId: ProjectAttentionItemId,
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)).annotate({
    description: "What the user actually said. Never an answer of your own.",
  }),
});
export type ProjectTeamAttentionAnswerInput = typeof ProjectTeamAttentionAnswerInput.Type;

export const ProjectTeamMemoryListInput = Schema.Struct({});
export type ProjectTeamMemoryListInput = typeof ProjectTeamMemoryListInput.Type;

export const ProjectTeamMemoryListResult = Schema.Struct({
  entries: Schema.Array(ProjectMemoryEntry),
});
export type ProjectTeamMemoryListResult = typeof ProjectTeamMemoryListResult.Type;

const ProjectMemoryTopic = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "Short topic key, such as testing or commit-style. Writing a topic replaces it.",
});

export const ProjectTeamMemoryWriteInput = Schema.Struct({
  topic: ProjectMemoryTopic,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
});
export type ProjectTeamMemoryWriteInput = typeof ProjectTeamMemoryWriteInput.Type;

export const ProjectTeamMemoryWriteResult = Schema.Struct({
  entry: ProjectMemoryEntry,
});
export type ProjectTeamMemoryWriteResult = typeof ProjectTeamMemoryWriteResult.Type;

export const ProjectTeamMemoryDeleteInput = Schema.Struct({
  topic: ProjectMemoryTopic,
});
export type ProjectTeamMemoryDeleteInput = typeof ProjectTeamMemoryDeleteInput.Type;

export const ProjectTeamMemoryDeleteResult = Schema.Struct({
  topic: Schema.String,
  deleted: Schema.Boolean,
});
export type ProjectTeamMemoryDeleteResult = typeof ProjectTeamMemoryDeleteResult.Type;

// Client RPCs.

export const ProjectManagerLastAction = Schema.Struct({
  text: Schema.String,
  at: IsoDateTime,
});
export type ProjectManagerLastAction = typeof ProjectManagerLastAction.Type;

/** At-a-glance status of the PM and its team. */
export const ProjectManagerPresence = Schema.Struct({
  running: NonNegativeInt,
  waitingOnUser: NonNegativeInt,
  stalled: NonNegativeInt,
  inbox: NonNegativeInt,
  nextSitrepAt: Schema.NullOr(IsoDateTime),
  lastAction: Schema.NullOr(ProjectManagerLastAction),
});
export type ProjectManagerPresence = typeof ProjectManagerPresence.Type;

export const ProjectTeamAttentionSummary = Schema.Struct({
  projectId: ProjectId,
  pmThreadId: ThreadId,
  openCount: NonNegativeInt,
  latestBatchId: Schema.NullOr(ProjectAttentionBatchId),
  latestSitrepId: Schema.NullOr(ProjectSitrepId),
  unreadSitrepCount: NonNegativeInt,
  /** True while a requested sitrep has no body yet. */
  sitrepInProgress: Schema.Boolean,
  settings: ProjectTeamSettings,
  /** Resolved persona, including the per-project default when none is stored. */
  persona: ProjectManagerPersona,
  enabled: Schema.Boolean,
  presence: ProjectManagerPresence,
});
export type ProjectTeamAttentionSummary = typeof ProjectTeamAttentionSummary.Type;

export const ProjectTeamSubscribeAttentionInput = Schema.Struct({});
export type ProjectTeamSubscribeAttentionInput = typeof ProjectTeamSubscribeAttentionInput.Type;

export const ProjectTeamAttentionSnapshot = Schema.Struct({
  projects: Schema.Array(ProjectTeamAttentionSummary),
});
export type ProjectTeamAttentionSnapshot = typeof ProjectTeamAttentionSnapshot.Type;

export const ProjectTeamRequestSitrepInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectTeamRequestSitrepInput = typeof ProjectTeamRequestSitrepInput.Type;

export const ProjectTeamRequestSitrepResult = Schema.Struct({
  sitrepId: ProjectSitrepId,
});
export type ProjectTeamRequestSitrepResult = typeof ProjectTeamRequestSitrepResult.Type;

export const ProjectTeamUpdateSettingsInput = Schema.Struct({
  projectId: ProjectId,
  sitrepIntervalMinutes: Schema.optional(ProjectTeamSitrepIntervalMinutes),
  sitrepNotify: Schema.optional(Schema.Boolean),
  persona: Schema.optional(
    Schema.Struct({
      name: Schema.optional(ProjectManagerName),
      avatar: Schema.optional(ProjectManagerAvatar),
      voice: Schema.optional(ProjectManagerVoice),
      voiceCustom: Schema.optional(ProjectManagerVoiceCustom),
    }),
  ),
  enabled: Schema.optional(Schema.Boolean),
});
export type ProjectTeamUpdateSettingsInput = typeof ProjectTeamUpdateSettingsInput.Type;

export class ProjectTeamError extends Schema.TaggedError<ProjectTeamError>()("ProjectTeamError", {
  message: Schema.String,
  projectId: Schema.optional(ProjectId),
  cause: Schema.optional(Schema.Defect()),
}) {}
