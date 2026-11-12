import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * The node graph BusyBoy reads from skill records (`.jwn/<task>/*.md`) and
 * provider question tool calls. A node is an agreed contract (ALIGN.md); its
 * status is everything that changes while the work runs.
 */

export const NodeCriterionCheck = Schema.Literals(["auto", "evidence", "human"]);
export type NodeCriterionCheck = typeof NodeCriterionCheck.Type;

export const NodeContractCriterion = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  check: Schema.NullOr(NodeCriterionCheck),
  how: Schema.NullOr(Schema.String),
});
export type NodeContractCriterion = typeof NodeContractCriterion.Type;

export const NodeWaitsOn = Schema.Struct({
  node: Schema.String,
  criterion: Schema.String,
});
export type NodeWaitsOn = typeof NodeWaitsOn.Type;

export const NodeFileChangeKind = Schema.Literals(["new", "modified", "deleted"]);
export type NodeFileChangeKind = typeof NodeFileChangeKind.Type;

export const NodeExpectedFile = Schema.Struct({
  path: Schema.String,
  change: Schema.NullOr(NodeFileChangeKind),
});
export type NodeExpectedFile = typeof NodeExpectedFile.Type;

/** The agreed end state, read from ALIGN.md. Fixed once approved. */
export const NodeContract = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  version: Schema.NullOr(Schema.Int),
  approved: Schema.NullOr(Schema.Struct({ by: Schema.String, on: Schema.String })),
  parent: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
  criteria: Schema.Array(NodeContractCriterion),
  dont: Schema.Array(Schema.String),
  waitsOn: Schema.Array(NodeWaitsOn),
  expectedFiles: Schema.Array(NodeExpectedFile),
});
export type NodeContract = typeof NodeContract.Type;

export const NodeState = Schema.Literals([
  "draft",
  "running",
  "asking",
  "review",
  "done",
  "failed",
  "stopped",
  "unknown",
]);
export type NodeState = typeof NodeState.Type;

export const NodeCriterionStatus = Schema.Literals(["pending", "proven", "failed"]);
export type NodeCriterionStatus = typeof NodeCriterionStatus.Type;

/** Who produced a piece of evidence, when the record says so. */
export const NodeEvidenceBy = Schema.Literals(["ci", "reviewer", "worker", "human"]);
export type NodeEvidenceBy = typeof NodeEvidenceBy.Type;

/** rerun: an independent rerun (CI or a reviewer). capture: a linked artifact. claim: words only. */
export const NodeEvidenceGrade = Schema.Literals(["rerun", "capture", "claim"]);
export type NodeEvidenceGrade = typeof NodeEvidenceGrade.Type;

export const NodeEvidence = Schema.Struct({
  text: Schema.String,
  ref: Schema.NullOr(Schema.String),
  by: Schema.NullOr(NodeEvidenceBy),
  grade: NodeEvidenceGrade,
});
export type NodeEvidence = typeof NodeEvidence.Type;

export const NodeCriterionResult = Schema.Struct({
  id: Schema.String,
  status: NodeCriterionStatus,
  evidence: Schema.Array(NodeEvidence),
});
export type NodeCriterionResult = typeof NodeCriterionResult.Type;

/** A verification row that could not be matched to a contract criterion. */
export const NodeUnmatchedResult = Schema.Struct({
  label: Schema.String,
  status: NodeCriterionStatus,
  evidence: Schema.Array(NodeEvidence),
});
export type NodeUnmatchedResult = typeof NodeUnmatchedResult.Type;

export const NodeReviewFinding = Schema.Struct({
  id: Schema.String,
  resolved: Schema.Boolean,
});
export type NodeReviewFinding = typeof NodeReviewFinding.Type;

export const NodeAskOption = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  recommended: Schema.Boolean,
});
export type NodeAskOption = typeof NodeAskOption.Type;

/** An action card made from a provider question tool call. */
export const NodeAsk = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  kind: Schema.Literal("question"),
  question: Schema.String,
  sub: Schema.NullOr(Schema.String),
  options: Schema.Array(NodeAskOption),
  answer: Schema.NullOr(
    Schema.Struct({ values: Schema.Array(Schema.String), at: Schema.NullOr(Schema.String) }),
  ),
});
export type NodeAsk = typeof NodeAsk.Type;

export const NodeDots = Schema.Struct({
  /** Blue: an unanswered card. */
  ask: Schema.Boolean,
  /** Red: a failed criterion. */
  failed: Schema.Boolean,
  /** Yellow: a criterion this node waits on is not proven yet. */
  waiting: Schema.Boolean,
});
export type NodeDots = typeof NodeDots.Type;

export const NodeChanges = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("compared"),
    base: Schema.String,
    expectedOnly: Schema.Array(Schema.String),
    actualOnly: Schema.Array(Schema.String),
    both: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export type NodeChanges = typeof NodeChanges.Type;

/** Everything that changes while the work runs. */
export const NodeStatus = Schema.Struct({
  state: NodeState,
  criteria: Schema.Array(NodeCriterionResult),
  unmatchedResults: Schema.Array(NodeUnmatchedResult),
  reviewFindings: Schema.Array(NodeReviewFinding),
  asks: Schema.Array(NodeAsk),
  /** Proven criteria over contract criteria; null without a contract. */
  progress: Schema.NullOr(Schema.Struct({ proven: Schema.Int, total: Schema.Int })),
  dots: NodeDots,
  changes: NodeChanges,
});
export type NodeStatus = typeof NodeStatus.Type;

export const NodeIssueKind = Schema.Literals([
  "missing_contract",
  "missing_title",
  "missing_criteria",
  "unreadable_file",
  "unresolved_dependency",
  "invalid_line",
]);
export type NodeIssueKind = typeof NodeIssueKind.Type;

/** A part of a record that could not be read. Shown, never hidden. */
export const NodeIssue = Schema.Struct({
  kind: NodeIssueKind,
  file: Schema.String,
  message: Schema.String,
});
export type NodeIssue = typeof NodeIssue.Type;

export const NodeTimelineEntry = Schema.Struct({
  at: Schema.String,
  changes: Schema.Array(Schema.String),
});
export type NodeTimelineEntry = typeof NodeTimelineEntry.Type;

export const GraphNode = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  recordPath: Schema.String,
  contract: Schema.NullOr(NodeContract),
  status: NodeStatus,
  issues: Schema.Array(NodeIssue),
  timeline: Schema.Array(NodeTimelineEntry),
});
export type GraphNode = typeof GraphNode.Type;

/** `from` waits on criterion `criterion` of node `to`. */
export const NodeGraphEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  criterion: Schema.String,
  satisfied: Schema.Boolean,
});
export type NodeGraphEdge = typeof NodeGraphEdge.Type;

export const NodeGraphUnlinkedAsk = Schema.Struct({
  projectId: ProjectId,
  ask: NodeAsk,
});
export type NodeGraphUnlinkedAsk = typeof NodeGraphUnlinkedAsk.Type;

export const NodeGraph = Schema.Struct({
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(NodeGraphEdge),
  unlinkedAsks: Schema.Array(NodeGraphUnlinkedAsk),
});
export type NodeGraph = typeof NodeGraph.Type;

export class NodeGraphError extends Schema.TaggedError<NodeGraphError>()("NodeGraphError", {
  message: Schema.String,
}) {}

export const NODE_SCHEMA_URL =
  "https://raw.githubusercontent.com/devjiwonchoi/busyboy/main/schema/node.schema.json";
export const STATUS_SCHEMA_URL =
  "https://raw.githubusercontent.com/devjiwonchoi/busyboy/main/schema/status.schema.json";

const toPublishedJsonSchema = (schema: Schema.Top, id: string, title: string) => {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
};

/** The checked-in schema/node.schema.json. */
export const nodeContractJsonSchema = () =>
  toPublishedJsonSchema(NodeContract, NODE_SCHEMA_URL, "BusyBoy node contract");

/** The checked-in schema/status.schema.json. */
export const nodeStatusJsonSchema = () =>
  toPublishedJsonSchema(NodeStatus, STATUS_SCHEMA_URL, "BusyBoy node status");
