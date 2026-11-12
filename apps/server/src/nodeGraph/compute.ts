import type {
  NodeAsk,
  NodeChanges,
  NodeContract,
  NodeContractCriterion,
  NodeCriterionResult,
  NodeCriterionStatus,
  NodeEvidence,
  NodeEvidenceBy,
  NodeEvidenceGrade,
  NodeExpectedFile,
  NodeStatus,
  NodeUnmatchedResult,
} from "@t3tools/contracts";

import type { ParsedRecord, VerifyRow } from "./parseJwn.ts";

const LINK = /(https?:\/\/[^\s)>\]]+)|\]\(([^)\s]+)\)/;

/** ci and reviewer rerun the check independently; a linked artifact is a capture; anything else is a claim. */
export const evidenceGrade = (by: NodeEvidenceBy | null, ref: string | null): NodeEvidenceGrade => {
  if (by === "ci" || by === "reviewer") return "rerun";
  return ref === null ? "claim" : "capture";
};

export const toEvidence = (row: VerifyRow): NodeEvidence => {
  const link = LINK.exec(row.evidence);
  const ref = link ? (link[1] ?? link[2] ?? null) : null;
  return { text: row.evidence, ref, by: row.by, grade: evidenceGrade(row.by, ref) };
};

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_"'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Matches a verification row to a criterion by its leading number, then by its words. */
export const matchCriterion = (
  row: VerifyRow,
  criteria: ReadonlyArray<NodeContractCriterion>,
): NodeContractCriterion | null => {
  const number = /^\s*(?:criterion\s*|기준\s*)?#?(\d+[a-z]?)\b/i.exec(row.label)?.[1];
  if (number !== undefined) {
    const byNumber = criteria.find((criterion) => criterion.id === number);
    if (byNumber) return byNumber;
  }
  const label = normalize(row.label.replace(/^\s*\d+[a-z]?\s*[.·:)]\s*/, ""));
  if (label.length === 0) return null;
  return (
    criteria.find((criterion) => normalize(criterion.text) === label) ??
    criteria.find((criterion) => {
      const text = normalize(criterion.text);
      return (
        label.length >= 8 && text.length >= 8 && (text.includes(label) || label.includes(text))
      );
    }) ??
    null
  );
};

/** VERIFY.md is a dated log, so the latest row for a criterion decides its status. */
const latestStatus = (statuses: ReadonlyArray<NodeCriterionStatus>): NodeCriterionStatus =>
  statuses.at(-1) ?? "pending";

const GRADE_RANK: Record<NodeEvidenceGrade, number> = { claim: 0, capture: 1, rerun: 2 };

/**
 * Whether a proven criterion counts toward progress and unblocks nodes waiting on it.
 * auto needs an independent rerun; human needs a person or reviewer to say so; evidence and
 * criteria without a `Check:` line need at least a captured artifact. A bare claim never counts.
 */
export const countsAsProven = (
  criterion: NodeContractCriterion,
  result: NodeCriterionResult | undefined,
) => {
  if (result?.status !== "proven") return false;
  // Only the row that set the status is graded; earlier rounds are history.
  const latest = result.evidence.at(-1);
  if (latest === undefined) return false;
  if (criterion.check === "human") return latest.by === "human" || latest.by === "reviewer";
  if (criterion.check === "auto") return GRADE_RANK[latest.grade] >= GRADE_RANK.rerun;
  return GRADE_RANK[latest.grade] >= GRADE_RANK.capture;
};

export const criterionResults = (
  contract: NodeContract | null,
  rows: ReadonlyArray<VerifyRow>,
): {
  readonly criteria: ReadonlyArray<NodeCriterionResult>;
  readonly unmatched: ReadonlyArray<NodeUnmatchedResult>;
} => {
  const matched = new Map<string, Array<VerifyRow>>();
  const unmatched: Array<NodeUnmatchedResult> = [];
  for (const row of rows) {
    const criterion = contract ? matchCriterion(row, contract.criteria) : null;
    if (criterion) {
      matched.set(criterion.id, [...(matched.get(criterion.id) ?? []), row]);
    } else {
      unmatched.push({ label: row.label, status: row.status, evidence: [toEvidence(row)] });
    }
  }
  const criteria = (contract?.criteria ?? []).map((criterion) => {
    const criterionRows = matched.get(criterion.id) ?? [];
    return {
      id: criterion.id,
      status: latestStatus(criterionRows.map((row) => row.status)),
      evidence: criterionRows.map(toEvidence),
    };
  });
  return { criteria, unmatched };
};

/** Compares the ALIGN file tree with the files that actually changed. A directory entry covers its files. */
export const compareChanges = (
  expected: ReadonlyArray<NodeExpectedFile>,
  actual: ReadonlyArray<string>,
  base: string,
): NodeChanges => {
  const covers = (entry: string, file: string) =>
    entry.endsWith("/") ? file.startsWith(entry) : entry === file;
  const both = actual.filter((file) => expected.some((entry) => covers(entry.path, file)));
  return {
    kind: "compared",
    base,
    expectedOnly: expected
      .map((entry) => entry.path)
      .filter((path) => !actual.some((file) => covers(path, file))),
    actualOnly: actual.filter((file) => !both.includes(file)),
    both,
  };
};

export interface StatusInput {
  readonly parsed: ParsedRecord;
  readonly asks: ReadonlyArray<NodeAsk>;
  /** True when a criterion this node waits on is not proven yet. */
  readonly waiting: boolean;
  readonly changes: NodeChanges;
}

export const buildStatus = ({ parsed, asks, waiting, changes }: StatusInput): NodeStatus => {
  const { criteria, unmatched } = criterionResults(parsed.contract, parsed.verifyRows);
  const contract = parsed.contract;
  const progress =
    contract === null
      ? null
      : {
          proven: contract.criteria.filter((criterion, index) =>
            countsAsProven(criterion, criteria[index]),
          ).length,
          total: contract.criteria.length,
        };
  const pendingAsk = asks.some((ask) => ask.answer === null);
  return {
    state: pendingAsk && parsed.state === "running" ? "asking" : parsed.state,
    criteria,
    unmatchedResults: unmatched,
    reviewFindings: parsed.reviewFindings,
    asks,
    progress,
    dots: {
      ask: pendingAsk,
      failed:
        criteria.some((result) => result.status === "failed") ||
        unmatched.some((result) => result.status === "failed"),
      waiting,
    },
    changes,
  };
};
