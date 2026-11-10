// @effect-diagnostics nodeBuiltinImport:off - PtyProcess.kill is synchronous, so the process table is read synchronously.
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";

/**
 * Signals a terminal's whole process tree on POSIX hosts.
 *
 * A pty child is a session leader, so `kill(-pid)` reaches every job still in
 * its process group. Shells with job control move background jobs into their
 * own groups, so descendants are also found by walking the process table.
 */
export interface ProcessTreeSignaler {
  /** Every live descendant of `rootPids`, excluding the roots themselves. */
  readonly descendants: (rootPids: ReadonlyArray<number>) => ReadonlyArray<number>;
  /** Sends `signal` to a pid (or a process group when negative). Never throws. */
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
}

export function descendantsFromTable(
  table: string,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  const roots = new Set(rootPids);
  const found = new Set<number>();
  const queue = [...rootPids];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of childrenByParent.get(next) ?? []) {
      if (roots.has(child) || found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

const readProcessTable = (): string => {
  try {
    return NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
};

export const posixProcessTreeSignaler: ProcessTreeSignaler = {
  descendants: (rootPids) => {
    const roots = rootPids.filter((pid) => Number.isInteger(pid) && pid > 1);
    return roots.length === 0 ? [] : descendantsFromTable(readProcessTable(), roots);
  },
  signal: (pid, signal) => {
    // Never signal pid 0/1 or the groups -0/-1: those reach far beyond the terminal.
    if (!Number.isInteger(pid) || Math.abs(pid) <= 1) return;
    try {
      process.kill(pid, signal);
    } catch {
      // ESRCH: already gone. EPERM: not ours to signal. Neither is actionable.
    }
  },
};

export const ProcessTreeSignalerRef = Context.Reference<ProcessTreeSignaler>(
  "server/terminal/ProcessTreeSignaler",
  { defaultValue: () => posixProcessTreeSignaler },
);
