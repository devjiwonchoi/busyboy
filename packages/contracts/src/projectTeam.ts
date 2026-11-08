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
import { ProviderInstanceId } from "./providerInstance.ts";

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
  /** A PM's or the Director's proposal; it becomes a task only when the user adds it. */
  "proposed",
  "inbox",
  "planning",
  /** The plan is written and waits for the user's approval. */
  "awaiting_approval",
  "running",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);
export type ProjectTaskStage = typeof ProjectTaskStage.Type;

/**
 * The lead's workflow phase, read from the stage: Align agrees on the plan, Iterate
 * builds and self-reviews it, Ship takes the pull request through review.
 */
export const ProjectTaskPhase = Schema.Literals(["align", "iterate", "ship"]);
export type ProjectTaskPhase = typeof ProjectTaskPhase.Type;

/** The phase of a stage; null once the task is blocked or finished. */
export function projectTaskPhase(stage: ProjectTaskStage): ProjectTaskPhase | null {
  switch (stage) {
    case "inbox":
    case "planning":
    case "awaiting_approval":
      return "align";
    case "running":
      return "iterate";
    case "in_review":
      return "ship";
    case "proposed":
    case "done":
    case "blocked":
    case "cancelled":
      return null;
  }
}

const ReviewHead = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "The commit the review covers: the output of `git rev-parse HEAD` in your worktree.",
});
const ReviewFindings = Schema.String.check(Schema.isMaxLength(20_000)).annotate({
  description: "What the review found, one per line; empty when clean.",
});

/** Who recorded a review: the task lead itself, or the review session task_delegate started. */
export const ProjectTaskReviewer = Schema.Literals(["lead", "reviewer"]);
export type ProjectTaskReviewer = typeof ProjectTaskReviewer.Type;

/** The latest review of the task's diff. */
export const ProjectTaskReview = Schema.Struct({
  clean: Schema.Boolean,
  findings: ReviewFindings,
  head: ReviewHead,
  reviewedAt: IsoDateTime,
  /** Reviews stored before reviewers existed were the lead's own. */
  by: ProjectTaskReviewer.pipe(Schema.withDecodingDefault(Effect.succeed("lead" as const))),
  /** The model that reviewed, when a review session did. */
  model: Schema.optionalKey(Schema.String),
});
export type ProjectTaskReview = typeof ProjectTaskReview.Type;

/**
 * How a task passed the Ready gate: the pull request's checks, or, when it has none,
 * the lead's local evidence on the same commit.
 */
export const ProjectTaskReadyGate = Schema.Literals(["checks", "local"]);
export type ProjectTaskReadyGate = typeof ProjectTaskReadyGate.Type;

const ReadyLocalChecks = Schema.String.check(Schema.isMaxLength(4_000)).annotate({
  description:
    "Only for a pull request with no checks: the commands you ran on HEAD (tests, typecheck, lint) and their result. Leave it empty when the pull request has checks.",
});

/** Set when the task passed the Ready gate; a new failure, comment or stage change clears it. */
export const ProjectTaskReady = Schema.Struct({
  head: ReviewHead,
  gate: ProjectTaskReadyGate,
  /** The commands the lead ran when the gate was local; empty for checks. */
  localChecks: ReadyLocalChecks,
  readyAt: IsoDateTime,
});
export type ProjectTaskReady = typeof ProjectTaskReady.Type;

/**
 * The four kinds of work in a task. The lead runs on the plan model; it hands the
 * other three to their models with task_delegate.
 */
export const ProjectTaskModelRole = Schema.Literals(["plan", "implement", "review", "fix"]);
export type ProjectTaskModelRole = typeof ProjectTaskModelRole.Type;
export const PROJECT_TASK_MODEL_ROLES: ReadonlyArray<ProjectTaskModelRole> = [
  "plan",
  "implement",
  "review",
  "fix",
];

/** A provider instance and one of its models, as orchestrator_capabilities lists them. */
export const ProjectTaskModelTarget = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ProjectTaskModelTarget = typeof ProjectTaskModelTarget.Type;

/** A model per role. A missing role runs on the lead's own model. */
export const ProjectTaskRoleModels = Schema.Struct({
  plan: Schema.optionalKey(ProjectTaskModelTarget),
  implement: Schema.optionalKey(ProjectTaskModelTarget),
  review: Schema.optionalKey(ProjectTaskModelTarget),
  fix: Schema.optionalKey(ProjectTaskModelTarget),
});
export type ProjectTaskRoleModels = typeof ProjectTaskRoleModels.Type;

/** A change to role models: a target sets the role, null clears it, absent keeps it. */
export const ProjectTaskRoleModelsPatch = Schema.Struct({
  plan: Schema.optionalKey(Schema.NullOr(ProjectTaskModelTarget)),
  implement: Schema.optionalKey(Schema.NullOr(ProjectTaskModelTarget)),
  review: Schema.optionalKey(Schema.NullOr(ProjectTaskModelTarget)),
  fix: Schema.optionalKey(Schema.NullOr(ProjectTaskModelTarget)),
}).annotate({
  description:
    "Provider and model per role (plan, implement, review, fix) from orchestrator_capabilities. null clears a role so it runs on the lead's own model.",
});
export type ProjectTaskRoleModelsPatch = typeof ProjectTaskRoleModelsPatch.Type;

/** Applies a patch to role models. */
export function applyRoleModelsPatch(
  current: ProjectTaskRoleModels,
  patch: ProjectTaskRoleModelsPatch,
): ProjectTaskRoleModels {
  const next: { -readonly [K in ProjectTaskModelRole]?: ProjectTaskModelTarget } = { ...current };
  for (const role of PROJECT_TASK_MODEL_ROLES) {
    const value = patch[role];
    if (value === undefined) continue;
    if (value === null) delete next[role];
    else next[role] = value;
  }
  return next;
}

/** The model a role runs on: the task's override, else the project default, else none. */
export function effectiveRoleModel(
  role: ProjectTaskModelRole,
  task: ProjectTaskRoleModels,
  project: ProjectTaskRoleModels | undefined,
): { readonly target: ProjectTaskModelTarget; readonly source: "task" | "project" } | null {
  const own = task[role];
  if (own !== undefined) return { target: own, source: "task" };
  const fallback = project?.[role];
  return fallback === undefined ? null : { target: fallback, source: "project" };
}

/** The model that last ran a role on a task, as delegate_task reported it. */
export const ProjectTaskModelStep = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  /** Null when the provider did not report a model. */
  model: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type ProjectTaskModelStep = typeof ProjectTaskModelStep.Type;

export const ProjectTaskModelSteps = Schema.Struct({
  plan: Schema.optionalKey(ProjectTaskModelStep),
  implement: Schema.optionalKey(ProjectTaskModelStep),
  review: Schema.optionalKey(ProjectTaskModelStep),
  fix: Schema.optionalKey(ProjectTaskModelStep),
});
export type ProjectTaskModelSteps = typeof ProjectTaskModelSteps.Type;

/** What one role's sessions spent on a task, summed over their runs. */
export const ProjectTaskStepUsage = Schema.Struct({
  durationMs: NonNegativeInt,
  runs: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  /** Estimated from list prices; null when no run's model had a known price. */
  costUsd: Schema.NullOr(Schema.Number),
});
export type ProjectTaskStepUsage = typeof ProjectTaskStepUsage.Type;

export const ProjectTaskStepUsages = Schema.Struct({
  plan: Schema.optionalKey(ProjectTaskStepUsage),
  implement: Schema.optionalKey(ProjectTaskStepUsage),
  review: Schema.optionalKey(ProjectTaskStepUsage),
  fix: Schema.optionalKey(ProjectTaskStepUsage),
});
export type ProjectTaskStepUsages = typeof ProjectTaskStepUsages.Type;

/** How big the lead judged the task when it planned it. */
export const ProjectTaskSize = Schema.Literals(["small", "medium", "large"]);
export type ProjectTaskSize = typeof ProjectTaskSize.Type;

/** Outcome counts kept per task, to compare model choices later. */
export const ProjectTaskMetrics = Schema.Struct({
  size: Schema.NullOr(ProjectTaskSize).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Finding lines across reviews that were not clean. */
  reviewFindings: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Fix steps handed off with task_delegate(role: "fix"). */
  fixRounds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Failed pull request checks that woke the lead. */
  ciFailures: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type ProjectTaskMetrics = typeof ProjectTaskMetrics.Type;

export const EMPTY_PROJECT_TASK_METRICS: ProjectTaskMetrics = {
  size: null,
  reviewFindings: 0,
  fixRounds: 0,
  ciFailures: 0,
};

export const ProjectTaskOutcome = Schema.Literals([
  "waiting_user",
  "in_review",
  "ready",
  "done",
  "failed",
  "stalled",
]);
export type ProjectTaskOutcome = typeof ProjectTaskOutcome.Type;

/**
 * The one status the user sees for a task. Stages are what agents store; the status
 * also reads live signals (an open question, the lead's turn) so it is derived, never stored.
 */
export const ProjectTaskStatus = Schema.Literals([
  "todo",
  "planning",
  "waiting_for_approval",
  "in_progress",
  "in_review",
  "ready",
  "ask_question",
  "fatal",
  "done",
]);
export type ProjectTaskStatus = typeof ProjectTaskStatus.Type;

export const PROJECT_TASK_STATUS_LABELS: Record<ProjectTaskStatus, string> = {
  todo: "Todo",
  planning: "Planning",
  waiting_for_approval: "Waiting for approval",
  in_progress: "In Progress",
  in_review: "In Review",
  ready: "Ready",
  ask_question: "Ask question",
  fatal: "Fatal",
  done: "Done",
};

/** Live signals that refine a task's stage into its status. */
export interface ProjectTaskStatusSignals {
  /** An open question or blocker from this task waits on the user. */
  readonly openQuestion: boolean;
  /**
   * A blocker card from this task is open: only a person can unblock it, as after the
   * PM's nudges ran out or a failed turn. Optional for callers that predate it.
   */
  readonly openBlocker?: boolean;
  /** The lead's current turn is running, or it waits on its own subagents or background work. */
  readonly leadRunning: boolean;
  /** The lead's latest turn failed. */
  readonly leadFailed: boolean;
}

/** Signals known from the stored task alone: its last turn's outcome. */
export function storedTaskStatusSignals(
  task: Pick<ProjectTask, "lastOutcome">,
): ProjectTaskStatusSignals {
  return {
    openQuestion: task.lastOutcome === "waiting_user",
    leadRunning: false,
    leadFailed: false,
  };
}

/**
 * The user-facing status. First match wins: Done, a failure, Waiting for approval,
 * an open blocker card, an open question, blocked, then the stage.
 * A stalled turn alone is not Fatal: leads end quiet turns all the time. It turns Fatal
 * only once the PM's nudges ran out and raised a blocker card.
 */
export function resolveProjectTaskStatus(
  task: Pick<ProjectTask, "stage" | "lastOutcome"> & {
    /** The task passed the Ready gate (its stored ready flag is set). */
    readonly ready?: boolean | undefined;
  },
  signals: ProjectTaskStatusSignals,
): ProjectTaskStatus {
  if (task.stage === "done" || task.stage === "cancelled") return "done";
  // A running turn means someone already restarted the lead after the failure.
  if ((signals.leadFailed || task.lastOutcome === "failed") && !signals.leadRunning) {
    return "fatal";
  }
  if (task.stage === "awaiting_approval") return "waiting_for_approval";
  // A working lead is past the blocker; the open card still asks the user.
  if (signals.openBlocker === true && !signals.leadRunning) return "fatal";
  if (signals.openQuestion) return "ask_question";
  if (task.stage === "blocked") return "fatal";
  switch (task.stage) {
    // A proposal never reaches a task list; read it as Todo if one does.
    case "proposed":
    case "inbox":
      return "todo";
    case "planning":
      return "planning";
    case "running":
      return "in_progress";
    case "in_review":
      return task.ready === true ? "ready" : "in_review";
  }
}

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
  /** The task this one was split from, shown as its parent. */
  parentTaskId: Schema.NullOr(ProjectTaskId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  leadThreadId: Schema.NullOr(ThreadId),
  prUrl: Schema.NullOr(Schema.String),
  planSummary: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
  lastOutcome: Schema.NullOr(ProjectTaskOutcome),
  nudgeCount: NonNegativeInt,
  /** Iterate rounds so far: entering running, or a review that was not clean, starts one. */
  iterateRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /**
   * Ship rounds so far: the first move into in_review starts one, and so does each
   * failed check, new comment or conflict on the watched pull request.
   */
  shipRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** The lead's latest self-review, recorded with task_review_set. */
  review: Schema.NullOr(ProjectTaskReview).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Set by task_ready once the pull request passed the Ready gate; the status reads it. */
  ready: Schema.NullOr(ProjectTaskReady).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** This task's model per role; a role it leaves out uses the project's. */
  roleModels: ProjectTaskRoleModels.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** The model that last ran each role. */
  modelSteps: ProjectTaskModelSteps.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Time, tokens and estimated cost per role. */
  stepUsage: ProjectTaskStepUsages.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  metrics: ProjectTaskMetrics.pipe(
    Schema.withDecodingDefault(Effect.succeed(EMPTY_PROJECT_TASK_METRICS)),
  ),
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
  phase: Schema.NullOr(ProjectTaskPhase).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  iterateRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  shipRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** What the user sees; use these names when talking to the user. */
  status: ProjectTaskStatus,
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
  /** The server answered a question for the user while AFK was on. */
  "afk_answer",
  /** A role ran on a model, such as "implement → codex · gpt-5.5". */
  "model_step",
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

const ProjectTaskSpecText = Schema.String.check(Schema.isMaxLength(60_000));
export const ProjectTaskTodoId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ProjectTaskTodoId = typeof ProjectTaskTodoId.Type;

/** Older specs have no structure; these decode as empty. */
const textOrEmpty = (maxLength: number) =>
  Schema.String.check(Schema.isMaxLength(maxLength)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  );
const noIds = Schema.Array(ProjectTaskTodoId).pipe(Schema.withDecodingDefault(Effect.succeed([])));

export const ProjectTaskTodo = Schema.Struct({
  id: ProjectTaskTodoId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  done: Schema.Boolean,
  /** Set once the todo was split into its own task. */
  subtaskId: Schema.NullOr(ProjectTaskId),
  /** Ids of the criteria this step builds. */
  criteria: noIds,
  /** Ids of the todos that must be done first. */
  dependsOn: noIds,
  /** The check that shows this step is done. */
  doneWhen: textOrEmpty(2_000),
});
export type ProjectTaskTodo = typeof ProjectTaskTodo.Type;

/** One success criterion: what must be true, how it is proven, and the proof once it exists. */
export const ProjectTaskCriterion = Schema.Struct({
  id: ProjectTaskTodoId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  /** How it will be proven, such as "server test" or "phone screenshot". */
  provenBy: textOrEmpty(2_000),
  /** The proof, recorded during the work with task_evidence_set. */
  evidence: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ProjectTaskCriterion = typeof ProjectTaskCriterion.Type;

export const ProjectTaskFileChange = Schema.Literals(["new", "changed", "deleted"]);
export type ProjectTaskFileChange = typeof ProjectTaskFileChange.Type;

/** A file the plan touches, and why. */
export const ProjectTaskFile = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  change: ProjectTaskFileChange,
  why: textOrEmpty(1_000),
  /** Ids of the todos that touch it. */
  todos: noIds,
});
export type ProjectTaskFile = typeof ProjectTaskFile.Type;

/** The written spec of a task. Every change is kept as a new version. */
export const ProjectTaskSpec = Schema.Struct({
  background: ProjectTaskSpecText,
  /**
   * The plan in the lead's own words, 2-4 sentences in the user's language: what is wrong
   * today and what the user sees when it is done. The approval card opens with it.
   */
  summary: textOrEmpty(4_000),
  /** What the end result looks like. */
  goal: ProjectTaskSpecText,
  /** How to tell the work is done. Older specs have none. */
  successCriteria: ProjectTaskSpecText.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  nonGoals: ProjectTaskSpecText,
  todos: Schema.Array(ProjectTaskTodo).check(Schema.isMaxLength(200)),
  /** A Mermaid diagram of the behavior once the work is done. */
  flow: textOrEmpty(60_000),
  /** A throwaway HTML mockup of the end state, for plans that change UI. */
  prototype: textOrEmpty(200_000),
  /** Why a plan that changes UI has no prototype. */
  prototypeWaiver: textOrEmpty(2_000),
  /** Success criteria as a checklist; successCriteria is the older free-text form. */
  criteria: Schema.Array(ProjectTaskCriterion)
    .check(Schema.isMaxLength(50))
    .pipe(Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<ProjectTaskCriterion>))),
  /** Every file the plan adds, changes or deletes. */
  files: Schema.Array(ProjectTaskFile)
    .check(Schema.isMaxLength(300))
    .pipe(Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<ProjectTaskFile>))),
}).check(
  Schema.makeFilter((spec) =>
    new Set(spec.todos.map((todo) => todo.id)).size === spec.todos.length
      ? true
      : "Each todo needs its own id.",
  ),
  Schema.makeFilter((spec) =>
    new Set(spec.criteria.map((criterion) => criterion.id)).size === spec.criteria.length
      ? true
      : "Each criterion needs its own id.",
  ),
);
export type ProjectTaskSpec = typeof ProjectTaskSpec.Type;

/** A spec with nothing planned yet. */
export function emptyProjectTaskSpec(background = ""): ProjectTaskSpec {
  return {
    background,
    summary: "",
    goal: "",
    successCriteria: "",
    nonGoals: "",
    todos: [],
    flow: "",
    prototype: "",
    prototypeWaiver: "",
    criteria: [],
    files: [],
  };
}

/** A new unchecked todo with no links yet. */
export function newProjectTaskTodo(id: string, text: string): ProjectTaskTodo {
  return { id, text, done: false, subtaskId: null, criteria: [], dependsOn: [], doneWhen: "" };
}

export const ProjectTaskSpecAuthor = Schema.Literals(["user", "pm", "agent"]);
export type ProjectTaskSpecAuthor = typeof ProjectTaskSpecAuthor.Type;

export const ProjectTaskSpecVersion = Schema.Struct({
  taskId: ProjectTaskId,
  /** 1 for the first version. */
  version: PositiveInt,
  spec: ProjectTaskSpec,
  author: ProjectTaskSpecAuthor,
  /** The agent or PM thread that wrote this version. Null when the user did. */
  authorThreadId: Schema.NullOr(ThreadId),
  /** Why the spec changed, such as "Restored v2". */
  note: Schema.String,
  createdAt: IsoDateTime,
});
export type ProjectTaskSpecVersion = typeof ProjectTaskSpecVersion.Type;

export const ProjectTaskSessionRole = Schema.Literals([
  "lead",
  "planner",
  "implementer",
  "reviewer",
]);
export type ProjectTaskSessionRole = typeof ProjectTaskSessionRole.Type;

/** An agent thread working on a task. Its own subagents are not listed here. */
export const ProjectTaskSession = Schema.Struct({
  taskId: ProjectTaskId,
  threadId: ThreadId,
  role: ProjectTaskSessionRole,
  createdAt: IsoDateTime,
});
export type ProjectTaskSession = typeof ProjectTaskSession.Type;

export const ProjectTaskKeyPrefix = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]{0,5}$/),
).annotate({ description: "Task ID prefix: 1 to 6 capital letters or digits, such as BB." });
export type ProjectTaskKeyPrefix = typeof ProjectTaskKeyPrefix.Type;

/** A prefix from the project's name: the initials of its words, or its first letters. */
export function defaultTaskKeyPrefix(projectTitle: string): string {
  const words = projectTitle
    .normalize("NFKD")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => /^[A-Za-z]/.test(word));
  const prefix =
    words.length >= 2
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  const upper = prefix.toUpperCase().slice(0, 6);
  return upper.length > 0 ? upper : "T";
}

/** A task's ID as people write it, such as BB-7. */
export function formatTaskKey(prefix: string, taskNumber: number): string {
  return `${prefix}-${taskNumber}`;
}

/** "proposal": a PM's or the Director's task proposal; only the user's click adds it. */
export const ProjectAttentionKind = Schema.Literals(["decision", "approval", "blocker", "proposal"]);
export type ProjectAttentionKind = typeof ProjectAttentionKind.Type;

/** "afk": the server answered for the user while AFK was on. */
export const ProjectAttentionAnsweredBy = Schema.Literals(["user", "pm", "afk"]);
export type ProjectAttentionAnsweredBy = typeof ProjectAttentionAnsweredBy.Type;

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
  /**
   * Set when the item closed without an answer: a newer question replaced it, its task
   * ended, or the PM or asking lead dismissed it with attention_dismiss.
   */
  supersededAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * Who answered: "user" clicked the card, "pm" relayed the user's chat words after the
   * server checked them, "afk" the server answered while the user's AFK setting was on. Null while open and for items answered before this was recorded.
   */
  answeredBy: Schema.NullOr(ProjectAttentionAnsweredBy).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** For a plan approval: the spec version the user reviews. Null for other kinds. */
  specVersion: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * For a plan approval: the card's Goal section (markdown). Older cards hold a single
   * free-form summary here, shown as Goal only. Null for other kinds.
   */
  summary: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** For a plan approval: the card's Verification section (markdown). Null for other kinds and older cards. */
  verification: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type ProjectAttentionItem = typeof ProjectAttentionItem.Type;

// Exact options distinguish actionable turn failures from existing free-form blockers.
export const TURN_FAILED_RETRY = "다시 시도";
export const TURN_FAILED_CANCEL = "태스크 취소";
export const TURN_FAILED_OPTIONS = [TURN_FAILED_RETRY, TURN_FAILED_CANCEL] as const;

export function isTurnFailedBlocker(item: Pick<ProjectAttentionItem, "kind" | "options">): boolean {
  return (
    item.kind === "blocker" &&
    item.options.length === TURN_FAILED_OPTIONS.length &&
    item.options.every((option, index) => option === TURN_FAILED_OPTIONS[index])
  );
}

export function turnFailedReason(detail: string | undefined): string | null {
  if (detail === undefined) {
    return null;
  }
  if (/\b401\b|unauthorized|token[_ ]expired|authentication/i.test(detail)) {
    return "로그인 만료 401";
  }
  if (/\b429\b|rate.?limit|usage limit|quota/i.test(detail)) {
    return "사용량 한도 429";
  }
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|timed? ?out/i.test(detail)) {
    return "네트워크 오류";
  }
  return null;
}

/** One step on a plan approval card: what gets done and how to tell it is done. */
export const ProjectApprovalPlanTodo = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  done: Schema.Boolean,
  doneWhen: Schema.String,
  /** Ids of the todos it comes after. */
  dependsOn: Schema.Array(Schema.String),
});
export type ProjectApprovalPlanTodo = typeof ProjectApprovalPlanTodo.Type;

/** A drafted subtask the approval covers: approving the parent approves it too. */
export const ProjectApprovalPlanSubtask = Schema.Struct({
  taskId: ProjectTaskId,
  number: PositiveInt,
  title: Schema.String,
  /** Its goal and verification, as the parent's lead wrote them. */
  request: Schema.String,
  waitsOn: Schema.Array(ProjectTaskId),
});
export type ProjectApprovalPlanSubtask = typeof ProjectApprovalPlanSubtask.Type;

/** What a plan approval card shows: the summary and the todos of the spec version it pins. */
export const ProjectApprovalPlan = Schema.Struct({
  summary: Schema.String,
  todos: Schema.Array(ProjectApprovalPlanTodo),
  /** The breakdown: drafted subtasks this one approval covers. */
  subtasks: Schema.Array(ProjectApprovalPlanSubtask).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ProjectApprovalPlan = typeof ProjectApprovalPlan.Type;

/** The approval card's plan, taken from a spec version and the subtasks it covers. */
export function approvalPlanOf(
  spec: ProjectTaskSpec,
  subtasks: ReadonlyArray<ProjectApprovalPlanSubtask> = [],
): ProjectApprovalPlan {
  return {
    summary: spec.summary,
    subtasks: [...subtasks],
    todos: spec.todos.map((todo) => ({
      id: todo.id,
      text: todo.text,
      done: todo.done,
      doneWhen: todo.doneWhen,
      dependsOn: todo.dependsOn,
    })),
  };
}

/** A question shown to the user as a card, with the name of the task that asked it. */
export const ProjectDecisionCard = Schema.Struct({
  item: ProjectAttentionItem,
  taskNumber: PositiveInt,
  taskTitle: Schema.String,
  /** For a plan approval: the plan it asks about. Null for other kinds and missing versions. */
  plan: Schema.NullOr(ProjectApprovalPlan).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * For a task proposal: the project the task goes to, which for the Director is not
   * the card's project. Null for other kinds.
   */
  proposal: Schema.NullOr(Schema.Struct({ projectId: ProjectId })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ProjectDecisionCard = typeof ProjectDecisionCard.Type;

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

/**
 * "pm" runs one project. "director" runs the whole workspace from a hidden system
 * project: it routes work to the projects' PMs and keeps epics, but starts no leads.
 */
export const ProjectManagerKind = Schema.Literals(["pm", "director"]);
export type ProjectManagerKind = typeof ProjectManagerKind.Type;

/** Lines the PM's "summary" memory topic may hold; the Director reads it. */
export const PROJECT_SUMMARY_MAX_LINES = 5;
/** Memory topic each PM keeps current for the Director. */
export const PROJECT_SUMMARY_TOPIC = "summary";

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

/**
 * AFK: while on, the server answers questions and approves plans on the user's behalf
 * with the recommended option, so agents keep working. It replaced "Auto-approve plans".
 * Only the user can set it, through the app; agent tools never accept it.
 */
export const ProjectTeamAfk = Schema.Struct({
  since: IsoDateTime,
  /** null: on until the user turns it off. */
  until: Schema.NullOr(IsoDateTime),
});
export type ProjectTeamAfk = typeof ProjectTeamAfk.Type;

/** Longest AFK window the app offers, in hours. */
export const MAX_AFK_HOURS = 24 * 7;

/** How long a question waits for the user before AFK answers it. */
export const AFK_GRACE_MS = 60_000;

/** The answer AFK gives a question that offers no options. */
export const AFK_FREE_FORM_ANSWER =
  "User is AFK: proceed with your recommended option and record the assumption.";

/** The project's AFK setting; settings saved before AFK carry "Auto-approve plans" over. */
export function afkSetting(
  settings: Pick<ProjectTeamSettings, "afk" | "autoApprovePlans">,
): ProjectTeamAfk | undefined {
  return settings.afk ?? settings.autoApprovePlans;
}

/** Whether AFK is on at `nowMs`. An expired window counts as off. */
export function afkActive(setting: ProjectTeamAfk | undefined, nowMs: number): boolean {
  if (setting === undefined) return false;
  if (setting.until === null) return true;
  const until = Date.parse(setting.until);
  return Number.isFinite(until) && until > nowMs;
}

/**
 * The option AFK picks: the one labelled "(Recommended)", else the first. Null when
 * there are no options, so the caller sends AFK_FREE_FORM_ANSWER.
 */
export function afkPickOption(options: ReadonlyArray<string>): string | null {
  return options.find((option) => /\(recommended\)/i.test(option)) ?? options[0] ?? null;
}

/** pm: the PM squash-merges clean Ready pull requests. user: the PM never merges. */
export const ProjectMergeOwner = Schema.Literals(["pm", "user"]);
export type ProjectMergeOwner = typeof ProjectMergeOwner.Type;

export const mergeOwnerOf = (settings: { readonly mergeOwner?: ProjectMergeOwner | undefined }) =>
  settings.mergeOwner ?? "pm";

export const ProjectTeamSettings = Schema.Struct({
  maxConcurrentTasks: ProjectTeamMaxConcurrentTasks.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_TEAM_MAX_CONCURRENT_TASKS)),
  ),
  sitrepIntervalMinutes: ProjectTeamSitrepIntervalMinutes.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_TEAM_SITREP_INTERVAL_MINUTES)),
  ),
  sitrepNotify: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  quietHours: Schema.optionalKey(ProjectTeamQuietHours),
  /** When the sitrep interval was set by hand. The server never adapts it after that. */
  intervalPinnedAt: Schema.optionalKey(IsoDateTime),
  /** Absent until the user or PM picks one; the server resolves a per-project default. */
  persona: Schema.optionalKey(ProjectManagerPersona),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Absent until the user picks one; the server derives it from the project's name. */
  taskKeyPrefix: Schema.optionalKey(ProjectTaskKeyPrefix),
  /** Absent when off. Only the user can set it, through the app. */
  afk: Schema.optionalKey(ProjectTeamAfk),
  /** Before AFK: "Auto-approve plans". Read as AFK by afkSetting; never written again. */
  autoApprovePlans: Schema.optionalKey(ProjectTeamAfk),
  /** The project's model per role; a task can override each one. */
  roleModels: Schema.optionalKey(ProjectTaskRoleModels),
  /** Who merges Ready pull requests. Absent means the PM. */
  mergeOwner: Schema.optionalKey(ProjectMergeOwner),
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
  awaiting_approval: Schema.Array(ProjectTaskBrief).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
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

export const ProjectOtherThreadStatus = Schema.Literals([
  "running",
  "waiting_on_user",
  "idle",
  "failed",
]);
export type ProjectOtherThreadStatus = typeof ProjectOtherThreadStatus.Type;

/** What a thread outside the task board is waiting on the user for. */
export const ProjectOtherThreadRequest = Schema.Struct({
  /** `reply`: the thread's turn ended and the user has not looked at it yet. */
  kind: Schema.Literals(["question", "approval", "plan", "reply"]),
  text: Schema.String,
  since: IsoDateTime,
});
export type ProjectOtherThreadRequest = typeof ProjectOtherThreadRequest.Type;

/**
 * A thread in the project that is neither the PM nor a task lead, such as one the
 * user started. Derived from the thread's state when read; never stored.
 */
export const ProjectOtherThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: ProjectOtherThreadStatus,
  /** Latest of: created, run started or finished, request raised, PR linked. */
  lastUpdateAt: IsoDateTime,
  latestMessage: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
  pendingRequest: Schema.NullOr(ProjectOtherThreadRequest),
});
export type ProjectOtherThread = typeof ProjectOtherThread.Type;

/** One project as the Director sees it. */
export const ProjectTeamWorkspaceProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  /** The PM's name. */
  pmName: Schema.String,
  taskKeyPrefix: Schema.String,
  statusCounts: Schema.Record(ProjectTaskStatus, NonNegativeInt),
  /** Tasks not done or cancelled. */
  openTasks: Schema.Array(ProjectTaskBrief),
  openAttention: Schema.Array(ProjectAttentionItem),
  /** The PM's "summary" memory topic, or null when it has none yet. */
  summary: Schema.NullOr(Schema.String),
});
export type ProjectTeamWorkspaceProject = typeof ProjectTeamWorkspaceProject.Type;

/** A subtask of an epic, which may live in any project. */
export const ProjectTeamEpicChild = Schema.Struct({
  id: ProjectTaskId,
  projectId: ProjectId,
  /** Such as BB-7. */
  key: Schema.String,
  title: Schema.String,
  status: ProjectTaskStatus,
});
export type ProjectTeamEpicChild = typeof ProjectTeamEpicChild.Type;

export const ProjectTeamEpic = Schema.Struct({
  task: ProjectTaskBrief,
  children: Schema.Array(ProjectTeamEpicChild),
});
export type ProjectTeamEpic = typeof ProjectTeamEpic.Type;

/** What team_status adds for the Director: every project and every epic. */
export const ProjectTeamWorkspace = Schema.Struct({
  projects: Schema.Array(ProjectTeamWorkspaceProject),
  epics: Schema.Array(ProjectTeamEpic),
});
export type ProjectTeamWorkspace = typeof ProjectTeamWorkspace.Type;

export const ProjectTeamStatus = Schema.Struct({
  projectId: ProjectId,
  /** Tasks are written as <prefix>-<number>, such as BB-7. */
  taskKeyPrefix: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("T"))),
  tasks: ProjectTeamTasksByStage,
  /** How many tasks have each user-facing status. */
  statusCounts: Schema.optional(Schema.Record(ProjectTaskStatus, NonNegativeInt)),
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
    /** Other threads whose lastUpdateAt is after `since`. */
    otherThreads: Schema.Array(ProjectOtherThread).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  }),
  /** Threads outside the task board, the ones waiting on the user first. */
  otherThreads: Schema.Array(ProjectOtherThread).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Latest done/failed tasks, decisions, and sitreps, newest first. */
  journal: Schema.Array(ProjectTeamJournalEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Topics of the PM's memory entries. */
  memoryTopics: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Director only: the whole workspace. */
  workspace: Schema.optional(ProjectTeamWorkspace),
});
export type ProjectTeamStatus = typeof ProjectTeamStatus.Type;

// MCP tool inputs and results.

const ProjectTeamListLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

export const ProjectTeamTaskCreateInput = Schema.Struct({
  title: ProjectTaskTitle,
  request: ProjectTaskRequest,
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "Director only. The project whose PM gets the task; omit to add an epic to your own project. A PM always adds to its own project.",
  }),
  waitsOn: Schema.optional(Schema.Array(ProjectTaskId)).annotate({
    description:
      "Tasks that must reach in_review or done before this one starts, such as tasks touching the same files. May be tasks in other projects.",
  }),
  parentTaskId: Schema.optional(ProjectTaskId).annotate({
    description:
      "PM and Director: the task this one is part of, shown as its parent. May be a task in another project. A task lead leaves it out: its subtasks are always its own task's.",
  }),
  intake: Schema.optional(ProjectTaskSummaryText).annotate({
    description:
      "PM and Director, required: one line on why this is new work, not a question you can answer or scope for an open task (nudge that one instead).",
  }),
  goal: Schema.optional(ProjectTaskRequest).annotate({
    description:
      "PM and Director, required: the end state the task delivers, in the user's language. Shown on the proposal card as 목표.",
  }),
  verification: Schema.optional(ProjectTaskRequest).annotate({
    description:
      "PM and Director, required: how to check it is done, in the user's language. Shown on the proposal card as 확인 방법.",
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
    description:
      "Provider and model for the task lead. Omit to use the PM's own. A plan model set for the project or task wins.",
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
    Schema.Literals([
      "inbox",
      "awaiting_approval",
      "running",
      "in_review",
      "done",
      "blocked",
      "cancelled",
    ]).annotate({
      description:
        'New stage. "inbox" parks a task without starting the work. "awaiting_approval": the plan is written and waits for the user\'s approval.',
    }),
  ),
  planSummary: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "The plan, in short.",
  }),
  resultSummary: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "What was delivered.",
  }),
  prUrl: Schema.optional(ProjectTaskPullRequestUrl),
  note: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "Progress note added to the task log.",
  }),
  title: Schema.optional(ProjectTaskTitle).annotate({
    description: "PM only. Rename the task.",
  }),
  waitsOn: Schema.optional(Schema.Array(ProjectTaskId)).annotate({
    description:
      "PM only. Replaces the tasks this one waits on; [] clears them. May be tasks in other projects.",
  }),
  parentTaskId: Schema.optional(Schema.NullOr(ProjectTaskId)).annotate({
    description:
      "PM only. The task this one is part of; null removes the parent. May be a task in another project.",
  }),
  size: Schema.optional(ProjectTaskSize).annotate({
    description:
      "How big the task is, judged from the plan: small (a few lines, low risk), medium, or large (many files or risky).",
  }),
}).check(
  Schema.makeFilter((input) =>
    input.size !== undefined ||
    input.stage !== undefined ||
    input.planSummary !== undefined ||
    input.resultSummary !== undefined ||
    input.prUrl !== undefined ||
    input.note !== undefined ||
    input.title !== undefined ||
    input.waitsOn !== undefined ||
    input.parentTaskId !== undefined
      ? true
      : "task_update needs at least one of stage, planSummary, resultSummary, prUrl, note, title, waitsOn, parentTaskId or size.",
  ),
);
export type ProjectTeamTaskUpdateInput = typeof ProjectTeamTaskUpdateInput.Type;

export const ProjectTeamTaskNudgeInput = Schema.Struct({
  taskId: ProjectTaskId,
  note: Schema.optional(ProjectTaskSummaryText).annotate({
    description: "What the task lead should do next, or the scope to add.",
  }),
  scope: Schema.optional(Schema.Boolean).annotate({
    description:
      "True when the note adds scope from the user rather than pushing a stalled lead. It never counts toward escalation, and it closes an open plan approval card so the lead folds the scope in and asks again.",
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
  // Only the user can write a custom voice, through the client; it goes into the PM's
  // system prompt.
  voice: Schema.optional(Schema.Literals(["chill", "dry", "chatty"])).annotate({
    description:
      "chill: relaxed and brief. dry: terse and matter-of-fact. chatty: warm and talkative.",
  }),
  taskKeyPrefix: Schema.optional(ProjectTaskKeyPrefix),
  roleModels: Schema.optional(ProjectTaskRoleModelsPatch),
  mergeOwner: Schema.optional(ProjectMergeOwner).annotate({
    description:
      "Who merges Ready pull requests: pm (you squash-merge clean ones) or user (you never merge; you send the user a merge brief).",
  }),
}).check(
  Schema.makeFilter((input) =>
    input.mergeOwner !== undefined ||
    input.roleModels !== undefined ||
    input.maxConcurrentTasks !== undefined ||
    input.sitrepIntervalMinutes !== undefined ||
    input.sitrepNotify !== undefined ||
    input.quietHours !== undefined ||
    input.name !== undefined ||
    input.avatarEmoji !== undefined ||
    input.voice !== undefined ||
    input.taskKeyPrefix !== undefined
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
  kind: Schema.Literals(["decision", "approval", "blocker"]).annotate({
    description:
      "decision: a choice only the user can make. approval: sign-off on the plan in the spec; the server attaches the latest spec version and shows the user a review card with the spec's summary and todos. blocker: something only a person can unblock.",
  }),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)).annotate({
    description:
      "Self-contained question. For approval, one line saying what the task is. For a decision or blocker, the first line is the question itself, naming the task; the card shows it as the title. Context goes below it and starts folded.",
  }),
  options: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
      Schema.isMaxLength(10),
    ),
  ).annotate({
    description:
      'Suggested answers, if any, shown as choices. Write each as "Label — one-line tradeoff" and mark the one you recommend with "(Recommended)".',
  }),
});
export type ProjectTeamAskUserInput = typeof ProjectTeamAskUserInput.Type;

/** Task proposal answers. Anything else is the user's feedback on the proposal. */
export const TASK_PROPOSAL_ACCEPT = "태스크로 추가";
export const TASK_PROPOSAL_DISMISS = "빼기";

export type TaskProposalOutcome = "accept" | "dismiss" | "feedback";

/** What an answer to a task proposal card means. */
export function taskProposalOutcome(answer: string): TaskProposalOutcome {
  const trimmed = answer.trim();
  if (trimmed === TASK_PROPOSAL_ACCEPT) {
    return "accept";
  }
  if (trimmed === TASK_PROPOSAL_DISMISS) {
    return "dismiss";
  }
  return "feedback";
}

/** Plan approval answers. Anything else is feedback on the plan. */
export const PLAN_APPROVAL_START = "Approve and start";
/** No longer offered; older cards may still carry this answer. */
export const PLAN_APPROVAL_ONLY = "Approve only";
/** First line of feedback sent from the plan review; comments follow. */
export const PLAN_CHANGES_REQUESTED = "Request changes";

export type PlanApprovalOutcome = "start" | "approve_only" | "changes";

/** What an answer to a plan approval card means. */
export function planApprovalOutcome(answer: string): PlanApprovalOutcome {
  const first = answer.trim().split("\n", 1)[0]?.trim() ?? "";
  if (first === PLAN_APPROVAL_START) return "start";
  if (first === PLAN_APPROVAL_ONLY) return "approve_only";
  return "changes";
}

/** A comment on text the user selected in the plan review. */
export interface PlanReviewComment {
  /** The plan section, such as "End result". */
  readonly section: string;
  /** The exact text the user selected. */
  readonly quote: string;
  readonly comment: string;
}

/** The answer the plan review sends when the user asks for changes. */
export function formatPlanReviewFeedback(input: {
  readonly specVersion: number | null;
  readonly comments: ReadonlyArray<PlanReviewComment>;
  readonly overall: string;
}): string {
  const head =
    input.specVersion === null
      ? PLAN_CHANGES_REQUESTED
      : `${PLAN_CHANGES_REQUESTED} (review of spec v${input.specVersion})`;
  return [head, ...planReviewNotes(input)].join("\n");
}

/** An approval that carries the reviewer's notes; it still reads as "start". */
export function formatPlanApproval(input: {
  readonly comments: ReadonlyArray<PlanReviewComment>;
  readonly overall: string;
}): string {
  return [PLAN_APPROVAL_START, ...planReviewNotes(input)].join("\n");
}

function planReviewNotes(input: {
  readonly comments: ReadonlyArray<PlanReviewComment>;
  readonly overall: string;
}): string[] {
  const lines: string[] = [];
  const overall = input.overall.trim();
  if (overall.length > 0) lines.push("", "Overall:", overall);
  if (input.comments.length > 0) {
    lines.push("", "Inline comments:");
    input.comments.forEach((entry, index) => {
      const quote = entry.quote.replace(/\s+/g, " ").trim();
      const comment = entry.comment.trim();
      lines.push(`${index + 1}. [${entry.section}] "${quote}"${comment ? ` → ${comment}` : ""}`);
    });
  }
  return lines;
}

const ProjectTeamOwnTaskId = Schema.optional(ProjectTaskId).annotate({
  description: "Task to use. A task lead may omit it for its own task; the PM passes it.",
});

export const ProjectTeamTaskSpecReadInput = Schema.Struct({ taskId: ProjectTeamOwnTaskId });
export type ProjectTeamTaskSpecReadInput = typeof ProjectTeamTaskSpecReadInput.Type;

export const ProjectTeamTaskSpecResult = Schema.Struct({
  /** Such as BB-7. */
  key: Schema.String,
  current: ProjectTaskSpecVersion,
});
export type ProjectTeamTaskSpecResult = typeof ProjectTeamTaskSpecResult.Type;

export const ProjectTeamTaskSpecWriteInput = Schema.Struct({
  taskId: ProjectTeamOwnTaskId,
  baseVersion: PositiveInt.annotate({
    description: "The version you read. A newer version makes the write fail; read it again.",
  }),
  spec: ProjectTaskSpec.annotate({
    description:
      "The whole spec. summary is 2-4 sentences in your own words, in the user's language: what is wrong today and what the user sees when it is done; the approval card opens with it. goal is the end state; criteria are checks, each with provenBy; each todo needs a doneWhen line (how the user can tell it is done) and lists the criteria it builds (criteria) and the todos it comes after (dependsOn); files lists every file with change and why; flow is a Mermaid diagram; prototype is an HTML mockup for UI changes, else prototypeWaiver says why not. Keep ids that already exist; give new todos and criteria a short new id such as t4 or c3.",
  }),
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description: 'Why it changed, in a few words, such as "Plan from the code review".',
  }),
});
export type ProjectTeamTaskSpecWriteInput = typeof ProjectTeamTaskSpecWriteInput.Type;

export const ProjectTeamTaskTodoSetInput = Schema.Struct({
  taskId: ProjectTeamOwnTaskId,
  todoId: ProjectTaskTodoId,
  done: Schema.Boolean,
});
export type ProjectTeamTaskTodoSetInput = typeof ProjectTeamTaskTodoSetInput.Type;

export const ProjectTeamTaskEvidenceSetInput = Schema.Struct({
  taskId: ProjectTeamOwnTaskId,
  criterionId: ProjectTaskTodoId,
  evidence: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)).annotate({
    description:
      "The proof that the criterion holds, such as the test that passed or a screenshot link.",
  }),
});
export type ProjectTeamTaskEvidenceSetInput = typeof ProjectTeamTaskEvidenceSetInput.Type;

export const ProjectTeamTaskReviewSetInput = Schema.Struct({
  taskId: ProjectTeamOwnTaskId,
  clean: Schema.Boolean.annotate({
    description: "True when the review found nothing left to fix in the diff.",
  }),
  findings: ReviewFindings,
  head: ReviewHead,
});
export type ProjectTeamTaskReviewSetInput = typeof ProjectTeamTaskReviewSetInput.Type;

export const ProjectTeamTaskReadyInput = Schema.Struct({
  taskId: ProjectTeamOwnTaskId,
  head: ReviewHead,
  localChecks: ReadyLocalChecks.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ProjectTeamTaskReadyInput = typeof ProjectTeamTaskReadyInput.Type;
/** Roles a lead hands off with task_delegate; it runs the plan role itself. */
export const ProjectTaskDelegatedRole = Schema.Literals(["implement", "review", "fix"]);
export type ProjectTaskDelegatedRole = typeof ProjectTaskDelegatedRole.Type;

export const ProjectTeamTaskDelegateInput = Schema.Struct({
  role: ProjectTaskDelegatedRole.annotate({
    description:
      "implement: build todos. review: review the diff against the spec and list findings. fix: fix the review findings.",
  }),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)).annotate({
    description:
      "Self-contained brief for the child: the spec parts it needs, for review the diff range, for fix the review findings.",
  }),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description: "Defaults to async. Use wait when this turn needs the result to continue.",
    }),
  ),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "Defaults to shared: the child works in your checkout. worktree gives it a copy from your current commit.",
    }),
  ),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type ProjectTeamTaskDelegateInput = typeof ProjectTeamTaskDelegateInput.Type;

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

export const ProjectTeamAttentionDismissInput = Schema.Struct({
  attentionItemId: ProjectAttentionItemId,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description:
      'Why the question no longer needs an answer, such as "The user chose option B in chat".',
  }),
});
export type ProjectTeamAttentionDismissInput = typeof ProjectTeamAttentionDismissInput.Type;

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

/** One success criterion of a goal, as All projects shows it: passed once evidence is recorded. */
export const ProjectTaskCheck = Schema.Struct({
  text: Schema.String,
  passed: Schema.Boolean,
});
export type ProjectTaskCheck = typeof ProjectTaskCheck.Type;

/** Enough of a task for the app to show "#N" as a named chip. */
export const ProjectTaskReference = Schema.Struct({
  id: ProjectTaskId,
  number: PositiveInt,
  /** Set for a task split from another; the sidebar nests it under its parent. */
  parentTaskId: Schema.NullOr(ProjectTaskId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Tasks this one waits on, possibly in other projects; open ones show it as blocked. */
  waitsOn: Schema.Array(ProjectTaskId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  title: Schema.String,
  stage: ProjectTaskStage,
  leadThreadId: Schema.NullOr(ThreadId),
  /** The task's pull request, shown on its sidebar row while in review. */
  prUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** How the lead's last turn ended; "stalled" marks a live task that stopped making progress. */
  lastOutcome: Schema.NullOr(ProjectTaskOutcome).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** An open question or blocker from this task waits on the user. */
  openQuestion: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** One of those is a blocker card, which only a person can unblock; the task shows Fatal. */
  openBlocker: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The task passed the Ready gate; an in-review task shows Ready only then. */
  ready: Schema.optional(Schema.Boolean),
  /** When the task last changed; null from servers that predate the field. */
  updatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Iterate and Ship rounds so far, shown on the phase badge; 0 from older servers. */
  iterateRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  shipRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** The model that last ran each role, shown on the plan card. */
  modelSteps: ProjectTaskModelSteps.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * For a top-level task (a goal): its latest spec's success criteria. Null for subtasks;
   * absent from servers that predate the field.
   */
  checks: Schema.optional(Schema.NullOr(Schema.Array(ProjectTaskCheck))),
});
export type ProjectTaskReference = typeof ProjectTaskReference.Type;

/** One-line preview of the PM chat's latest message, shown on the sidebar manager row. */
export const ProjectManagerLastMessage = Schema.Struct({
  role: Schema.Literals(["assistant", "user"]),
  text: Schema.String,
  at: IsoDateTime,
});
export type ProjectManagerLastMessage = typeof ProjectManagerLastMessage.Type;

/**
 * One question AFK answered for the user. `threadId` is the thread that asked, `taskId`
 * the task it belongs to (null for a thread outside any task).
 */
export const ProjectAfkAnswer = Schema.Struct({
  id: ProjectTaskEventId,
  at: IsoDateTime,
  threadId: Schema.NullOr(ThreadId),
  taskId: Schema.NullOr(ProjectTaskId),
  /** "question → answer", as logged. */
  text: Schema.String,
});
export type ProjectAfkAnswer = typeof ProjectAfkAnswer.Type;

/** Most AFK answers a summary carries; the newest are kept. */
export const MAX_AFK_ANSWERS_IN_SUMMARY = 50;

/** Log body of an AFK answer. */
export function afkAnswerEventBody(question: string, answer: string): string {
  const trimmed = question.length > 300 ? `${question.slice(0, 300)}…` : question;
  return `${trimmed} → ${answer}`;
}

export const ProjectTeamAttentionSummary = Schema.Struct({
  projectId: ProjectId,
  pmThreadId: ThreadId,
  /** "director": the workspace Director's hidden system project, not a user project. Absent means "pm". */
  kind: Schema.optional(ProjectManagerKind),
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
  /** Open questions plus the latest closed ones, oldest first, shown as cards in the PM thread. */
  decisionCards: Schema.Array(ProjectDecisionCard).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Every task in the project, so "#N" in PM text can be resolved per project. */
  tasks: Schema.Array(ProjectTaskReference),
  /** Resolved task ID prefix, such as BB for BB-7. */
  taskKeyPrefix: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("T"))),
  /** The PM chat's latest message the user would see, or null before the first one. */
  lastMessage: Schema.NullOr(ProjectManagerLastMessage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Questions AFK answered since it was last turned on, oldest first. Empty while off. */
  afkAnswers: Schema.Array(ProjectAfkAnswer).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** The first line of the PM's "direction" memory, or null when there is none. */
  direction: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
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

export const ProjectTeamAnswerDecisionInput = Schema.Struct({
  projectId: ProjectId,
  attentionItemId: ProjectAttentionItemId,
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type ProjectTeamAnswerDecisionInput = typeof ProjectTeamAnswerDecisionInput.Type;

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
  taskKeyPrefix: Schema.optional(ProjectTaskKeyPrefix),
  roleModels: Schema.optional(ProjectTaskRoleModelsPatch),
  mergeOwner: Schema.optional(ProjectMergeOwner),
  /**
   * User-only: turns AFK on for `hours` (null = until turned off), or off with null.
   * Deliberately absent from team_settings_update so no agent can set it.
   */
  afk: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        hours: Schema.NullOr(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_AFK_HOURS })),
        ),
      }),
    ),
  ),
});
export type ProjectTeamUpdateSettingsInput = typeof ProjectTeamUpdateSettingsInput.Type;

// App-facing task RPCs.

export const ProjectTeamTaskRefInput = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectTaskId,
});
export type ProjectTeamTaskRefInput = typeof ProjectTeamTaskRefInput.Type;

export const ProjectTeamTaskDetail = Schema.Struct({
  task: ProjectTask,
  /** Such as BB-7. */
  key: Schema.String,
  /** Oldest first; the last one is current. */
  versions: Schema.Array(ProjectTaskSpecVersion),
  sessions: Schema.Array(ProjectTaskSession),
  children: Schema.Array(ProjectTaskBrief),
  /** Open questions pinned on the task. */
  openAttention: Schema.Array(ProjectAttentionItem),
});
export type ProjectTeamTaskDetail = typeof ProjectTeamTaskDetail.Type;

export const ProjectTeamUpdateTaskSpecInput = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectTaskId,
  /** The version the edit started from; a newer version makes the update fail. */
  baseVersion: PositiveInt,
  spec: ProjectTaskSpec,
  note: Schema.optional(TrimmedString.check(Schema.isMaxLength(500))),
});
export type ProjectTeamUpdateTaskSpecInput = typeof ProjectTeamUpdateTaskSpecInput.Type;

export const ProjectTeamRestoreTaskSpecInput = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectTaskId,
  version: PositiveInt,
});
export type ProjectTeamRestoreTaskSpecInput = typeof ProjectTeamRestoreTaskSpecInput.Type;

export const ProjectTeamSplitTaskTodoInput = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectTaskId,
  todoId: ProjectTaskTodoId,
});
export type ProjectTeamSplitTaskTodoInput = typeof ProjectTeamSplitTaskTodoInput.Type;

export const ProjectTeamSplitTaskTodoResult = Schema.Struct({
  subtask: ProjectTask,
  parent: ProjectTeamTaskDetail,
});
export type ProjectTeamSplitTaskTodoResult = typeof ProjectTeamSplitTaskTodoResult.Type;

/** projectTeam.setTaskRoleModels: the user overrides the project's role models for one task. */
export const ProjectTeamSetTaskRoleModelsInput = Schema.Struct({
  projectId: ProjectId,
  taskId: ProjectTaskId,
  roleModels: ProjectTaskRoleModelsPatch,
});
export type ProjectTeamSetTaskRoleModelsInput = typeof ProjectTeamSetTaskRoleModelsInput.Type;

export class ProjectTeamError extends Schema.TaggedError<ProjectTeamError>()("ProjectTeamError", {
  message: Schema.String,
  projectId: Schema.optional(ProjectId),
  cause: Schema.optional(Schema.Defect()),
}) {}
