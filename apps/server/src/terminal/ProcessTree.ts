// @effect-diagnostics nodeBuiltinImport:off - PtyProcess.kill is synchronous and fire-and-forget, so the process table is read with a plain callback API.
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";

/**
 * Signals a terminal's whole process tree on POSIX hosts.
 *
 * A pty child is a session leader, so `kill(-pid)` reaches every job still in
 * its process group. Shells with job control move background jobs into their
 * own groups, so descendants are also found by walking the process table.
 * Each process is known by its pid and start time, so a pid the OS has since
 * given to another process is never signalled.
 */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** The start time as `ps` prints it; with the pid it names one process. */
  readonly startedAt: string;
}

export interface ProcessTreeSignaler {
  /** The process table; empty when it cannot be read. Never rejects, never blocks. */
  readonly table: () => Promise<ReadonlyArray<ProcessEntry>>;
  /** Sends `signal` to a pid (or a process group when negative). Never throws. */
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
}

/** Parses `ps -A -o pid=,ppid=,pgid=,lstart=`. */
export function parseProcessTable(output: string): ReadonlyArray<ProcessEntry> {
  const entries: Array<ProcessEntry> = [];
  for (const line of output.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4]!,
    });
  }
  return entries;
}

/** Every descendant of `rootPids` in `table`, excluding the roots themselves. */
export function descendantsOf(
  table: ReadonlyArray<ProcessEntry>,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ProcessEntry> {
  const childrenByParent = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry);
    childrenByParent.set(entry.ppid, children);
  }
  const roots = new Set(rootPids);
  const found = new Map<number, ProcessEntry>();
  const queue = [...rootPids];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of childrenByParent.get(next) ?? []) {
      if (roots.has(child.pid) || found.has(child.pid)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return [...found.values()];
}

const readProcessTable = (): Promise<string> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      // A fixed locale keeps the start time's format stable between reads.
      { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });

export const posixProcessTreeSignaler: ProcessTreeSignaler = {
  table: () => readProcessTable().then(parseProcessTable),
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
