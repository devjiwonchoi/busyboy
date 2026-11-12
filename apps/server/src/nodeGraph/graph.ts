// @effect-diagnostics nodeBuiltinImport:off - record folders are read with plain async fs and git so the adapter is testable without platform layers.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  GraphNode,
  NodeAsk,
  NodeChanges,
  NodeGraph,
  NodeGraphEdge,
  NodeGraphUnlinkedAsk,
  NodeIssue,
  ProjectId,
} from "@t3tools/contracts";

import { buildStatus, countsAsProven } from "./compute.ts";
import { RECORD_FILES, type ParsedRecord, type RecordFiles } from "./parseJwn.ts";

/** Bounds one scan so a huge or runaway `.jwn` folder cannot stall the server. */
export const MAX_RECORD_DIRS = 500;

export interface RecordDir {
  readonly nodeId: string;
  readonly dirName: string;
  readonly path: string;
  /** The checkout the record describes; actual changes are read here. */
  readonly workdir: string;
  readonly projectId: ProjectId | null;
}

export interface ProjectRoot {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

const listDirs = async (path: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
};

const hasRecord = async (path: string) => {
  try {
    const names = await readdir(path);
    return RECORD_FILES.some((name) => names.includes(name));
  } catch {
    return false;
  }
};

const shortHash = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 6);

const canonicalPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/** The project's linked worktrees, so records written inside a worktree are found too. */
export const listWorktrees = (root: string) =>
  new Promise<ReadonlyArray<string>>((resolve) => {
    // Compared by canonical path by the caller, so the main checkout is never listed twice.
    execFile(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: root, timeout: 10_000 },
      (error, stdout) => {
        if (error) return resolve([]);
        resolve(
          stdout
            .toString()
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice("worktree ".length).trim()),
        );
      },
    );
  });

/**
 * Every `.jwn/<task>/` folder of the registered projects and their worktrees, plus parent
 * nodes kept outside any repository in `<nodesHome>/<id>/`.
 */
export const listRecordDirs = async (input: {
  readonly projects: ReadonlyArray<ProjectRoot>;
  readonly nodesHome: string;
  readonly worktreesOf?: (root: string) => Promise<ReadonlyArray<string>>;
}): Promise<ReadonlyArray<RecordDir>> => {
  const worktreesOf = input.worktreesOf ?? listWorktrees;
  const dirs: Array<RecordDir> = [];
  const taken = new Set<string>();
  const add = (dir: Omit<RecordDir, "nodeId">, nodeId: string, checkoutName: string) => {
    if (dirs.length >= MAX_RECORD_DIRS) return;
    let unique = taken.has(nodeId) ? `${nodeId}@${checkoutName}` : nodeId;
    // Two worktrees can share a folder name; fall back to a hash of the record path.
    if (taken.has(unique)) unique = `${nodeId}@${shortHash(dir.path)}`;
    taken.add(unique);
    dirs.push({ ...dir, nodeId: unique });
  };
  // Projects sharing a folder name get a suffix from their path, so ids never depend on scan order.
  const nameCounts = new Map<string, number>();
  for (const project of input.projects) {
    const name = basename(project.workspaceRoot);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const repoNameOf = (project: ProjectRoot) => {
    const name = basename(project.workspaceRoot);
    return (nameCounts.get(name) ?? 0) > 1 ? `${name}-${shortHash(project.workspaceRoot)}` : name;
  };
  // Every project root before any worktree, so a checkout that is one project's root and
  // another's worktree always belongs to the project whose root it is.
  const checkouts: Array<{ readonly project: ProjectRoot; readonly path: string }> = [
    ...input.projects.map((project) => ({ project, path: project.workspaceRoot })),
  ];
  for (const project of input.projects) {
    for (const path of (await worktreesOf(project.workspaceRoot)).toSorted()) {
      checkouts.push({ project, path });
    }
  }
  const visited = new Set<string>();
  for (const { project, path: checkout } of checkouts) {
    const canonical = await canonicalPath(checkout);
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const jwn = join(checkout, ".jwn");
    for (const dirName of await listDirs(jwn)) {
      const path = join(jwn, dirName);
      if (!(await hasRecord(path))) continue;
      add(
        { dirName, path, workdir: checkout, projectId: project.projectId },
        `${repoNameOf(project)}/${dirName}`,
        basename(checkout),
      );
    }
  }
  for (const dirName of await listDirs(input.nodesHome)) {
    const path = join(input.nodesHome, dirName);
    if (!(await hasRecord(path))) continue;
    add({ dirName, path, workdir: path, projectId: null }, dirName, "nodes");
  }
  return dirs;
};

export const readRecordFiles = async (path: string): Promise<RecordFiles> => {
  const files: Record<string, string | { readonly error: string }> = {};
  for (const name of RECORD_FILES) {
    try {
      files[name] = await readFile(join(path, name), "utf8");
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      files[name] = { error: code ?? String(cause) };
    }
  }
  return files as RecordFiles;
};

export interface GraphEntry {
  readonly dir: RecordDir;
  readonly parsed: ParsedRecord;
  readonly asks: ReadonlyArray<NodeAsk>;
  readonly changes: NodeChanges;
}

/** Links nodes by the criteria they wait on and works out each node's status. */
export const buildGraph = (
  entries: ReadonlyArray<GraphEntry>,
  unlinkedAsks: ReadonlyArray<NodeGraphUnlinkedAsk> = [],
): NodeGraph => {
  const firstPass = new Map(
    entries.map((entry) => [
      entry.dir.nodeId,
      buildStatus({
        parsed: entry.parsed,
        asks: entry.asks,
        waiting: false,
        changes: entry.changes,
      }),
    ]),
  );
  const contracts = new Map(entries.map((entry) => [entry.dir.nodeId, entry.parsed.contract]));
  const edges: Array<NodeGraphEdge> = [];
  const extraIssues = new Map<string, Array<NodeIssue>>();
  for (const entry of entries) {
    for (const wait of entry.parsed.contract?.waitsOn ?? []) {
      const target = firstPass.get(wait.node);
      const result = target?.criteria.find((criterion) => criterion.id === wait.criterion);
      const criterion = contracts
        .get(wait.node)
        ?.criteria.find((item) => item.id === wait.criterion);
      if (target === undefined || result === undefined) {
        extraIssues.set(entry.dir.nodeId, [
          ...(extraIssues.get(entry.dir.nodeId) ?? []),
          {
            kind: "unresolved_dependency",
            file: "ALIGN.md",
            message:
              target === undefined
                ? `Node ${wait.node} this node waits on was not found.`
                : `${wait.node} has no criterion ${wait.criterion}.`,
          },
        ]);
      }
      edges.push({
        from: entry.dir.nodeId,
        to: wait.node,
        criterion: wait.criterion,
        // The same graded rule as progress, so a bare claim never unblocks a dependent node.
        satisfied: criterion !== undefined && countsAsProven(criterion, result),
      });
    }
  }
  const nodes: Array<GraphNode> = entries.map((entry) => {
    const waiting = edges.some((edge) => edge.from === entry.dir.nodeId && !edge.satisfied);
    return {
      id: entry.dir.nodeId,
      projectId: entry.dir.projectId,
      recordPath: entry.dir.path,
      contract: entry.parsed.contract,
      status: buildStatus({
        parsed: entry.parsed,
        asks: entry.asks,
        waiting,
        changes: entry.changes,
      }),
      issues: [...entry.parsed.issues, ...(extraIssues.get(entry.dir.nodeId) ?? [])],
      timeline: [],
    };
  });
  return { nodes, edges, unlinkedAsks };
};
