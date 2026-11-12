// @effect-diagnostics nodeBuiltinImport:off - the timeline is a small append-only JSONL file written with plain async fs.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { NodeStatus, NodeTimelineEntry } from "@t3tools/contracts";

/** Entries returned with each node; the full history stays on disk. */
export const TIMELINE_LIMIT = 20;

/** What the timeline compares between observations. */
export interface TimelineSnapshot {
  readonly state: string;
  readonly criteria: Readonly<Record<string, string>>;
  readonly unmatched: Readonly<Record<string, string>>;
  readonly review: Readonly<Record<string, boolean>>;
}

interface StoredEntry extends NodeTimelineEntry {
  readonly snapshot: TimelineSnapshot;
}

export const snapshotOf = (status: NodeStatus): TimelineSnapshot => ({
  state: status.state,
  criteria: Object.fromEntries(status.criteria.map((result) => [result.id, result.status])),
  unmatched: Object.fromEntries(
    status.unmatchedResults.map((result) => [result.label, result.status]),
  ),
  review: Object.fromEntries(
    status.reviewFindings.map((finding) => [finding.id, finding.resolved]),
  ),
});

export const describeChanges = (
  previous: TimelineSnapshot | null,
  next: TimelineSnapshot,
): ReadonlyArray<string> => {
  if (previous === null) return ["First observation of this record."];
  const changes: Array<string> = [];
  if (previous.state !== next.state) changes.push(`State: ${previous.state} → ${next.state}`);
  for (const [id, status] of Object.entries(next.criteria)) {
    const before = previous.criteria[id];
    if (before !== status) changes.push(`Criterion ${id}: ${before ?? "none"} → ${status}`);
  }
  for (const id of Object.keys(previous.criteria)) {
    if (!(id in next.criteria)) changes.push(`Criterion ${id}: removed`);
  }
  for (const [label, status] of Object.entries(next.unmatched)) {
    const before = previous.unmatched[label];
    if (before !== status) changes.push(`Verification "${label}": ${before ?? "none"} → ${status}`);
  }
  for (const [id, resolved] of Object.entries(next.review)) {
    const before = previous.review[id];
    if (before === undefined) changes.push(`Review ${id}: new${resolved ? " (resolved)" : ""}`);
    else if (before !== resolved)
      changes.push(`Review ${id}: ${resolved ? "resolved" : "reopened"}`);
  }
  return changes;
};

/** `<nodesHome>/<id>/timeline.jsonl`; ids are `repo/task`, so each part becomes a folder. */
export const timelinePath = (nodesHome: string, nodeId: string) =>
  join(
    nodesHome,
    ...nodeId.split("/").map((part) => part.replace(/^\.+$/, "_").replace(/[\\:]/g, "_")),
    "timeline.jsonl",
  );

const readEntries = async (path: string): Promise<ReadonlyArray<StoredEntry>> => {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as StoredEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/**
 * Appends one entry when the record changed since the last observation, and
 * returns the latest entries. The skills never write this; the harness does.
 */
export const observeTimeline = async (input: {
  readonly nodesHome: string;
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly now: string;
}): Promise<ReadonlyArray<NodeTimelineEntry>> => {
  const path = timelinePath(input.nodesHome, input.nodeId);
  const entries = await readEntries(path);
  const next = snapshotOf(input.status);
  const previous = entries.at(-1)?.snapshot ?? null;
  let all = entries;
  if (previous === null || JSON.stringify(previous) !== JSON.stringify(next)) {
    const entry: StoredEntry = {
      at: input.now,
      changes: describeChanges(previous, next),
      snapshot: next,
    };
    await mkdir(join(path, ".."), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`);
    all = [...entries, entry];
  }
  return all.slice(-TIMELINE_LIMIT).map(({ at, changes }) => ({ at, changes }));
};
