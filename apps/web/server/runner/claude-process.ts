import { execFile, spawn, type ChildProcess } from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { onServerShutdown } from "../shutdown";

const GRACE_SECONDS = 5;
const STDERR_TAIL = 2000;

type TrackedProcess = { stop: () => Promise<void> };
type LiveProcesses = { processes: Set<TrackedProcess>; hooked: boolean };
const LIVE_KEY = Symbol.for("busyboy.claude-processes");
const liveProcesses: LiveProcesses = ((
  globalThis as typeof globalThis & { [LIVE_KEY]?: LiveProcesses }
)[LIVE_KEY] ??= { processes: new Set(), hooked: false });

function stopTrackedProcesses() {
  return Promise.allSettled([...liveProcesses.processes].map((process) => process.stop())).then(
    () => undefined,
  );
}

function hookProcessShutdown() {
  if (liveProcesses.hooked) return;
  liveProcesses.hooked = true;
  onServerShutdown(stopTrackedProcesses);
  process.once("SIGTERM", () => void stopTrackedProcesses());
  process.once("SIGINT", () => void stopTrackedProcesses());
}

const WATCH_SCRIPT = [
  `{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep ${GRACE_SECONDS}; kill -KILL 0; } </dev/null >/dev/null 2>&1 &`,
  'exec "$@" 3<&-',
].join("\n");

export type ClaudeProcess = SpawnedProcess & {
  stop(): Promise<void>;
  stderrTail(): string;
};

function signal(target: number, name: NodeJS.Signals) {
  try {
    process.kill(target, name);
  } catch {}
}

function detachedDescendants(root: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid="], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve([]);
      const children = new Map<number, { pid: number; pgid: number }[]>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (!pid || !ppid || !pgid) continue;
        children.set(ppid, [...(children.get(ppid) ?? []), { pid, pgid }]);
      }
      const leaders: number[] = [];
      const queue = [root];
      while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
          if (child.pgid === child.pid) leaders.push(child.pid);
          queue.push(child.pid);
        }
      }
      resolve(leaders);
    });
  });
}

export function spawnClaudeProcess(options: SpawnOptions): ClaudeProcess {
  const env = options.env as NodeJS.ProcessEnv;
  let tail = "";
  const readStderr = (child: ChildProcess) =>
    child.stderr
      ?.setEncoding("utf8")
      .on("data", (chunk: string) => (tail = (tail + chunk).slice(-STDERR_TAIL)));
  const stderrTail = () => tail.trim();

  if (process.platform === "win32") {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readStderr(child);
    const tracked = { stop: async () => void child.kill() };
    hookProcessShutdown();
    liveProcesses.processes.add(tracked);
    child.once("exit", () => liveProcesses.processes.delete(tracked));
    return Object.assign(child, { stop: tracked.stop, stderrTail });
  }

  const child: ChildProcess = spawn(
    "/bin/sh",
    ["-c", WATCH_SCRIPT, "busyboy-claude", options.command, ...options.args],
    {
      cwd: options.cwd,
      env,
      signal: options.signal,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  readStderr(child);
  let exited = false;
  let stopping: Promise<void> | undefined;
  const tracked = {
    stop: () => (stopping ??= sweep()),
  };
  const sweep = async () => {
    if (exited || !child.pid) return;
    const pid = child.pid;
    const leaders = await detachedDescendants(pid);
    for (const leader of leaders) signal(-leader, "SIGTERM");
    if (!exited) signal(-pid, "SIGTERM");
    setTimeout(() => {
      for (const leader of leaders) signal(-leader, "SIGKILL");
      if (!exited) signal(-pid, "SIGKILL");
    }, GRACE_SECONDS * 1000).unref();
  };
  hookProcessShutdown();
  liveProcesses.processes.add(tracked);
  child.once("exit", () => {
    exited = true;
    liveProcesses.processes.delete(tracked);
    if (child.pid) signal(-child.pid, "SIGKILL");
  });
  return Object.assign(child as ChildProcess & SpawnedProcess, { stop: tracked.stop, stderrTail });
}
