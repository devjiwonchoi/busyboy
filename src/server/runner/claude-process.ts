import { execFile, spawn, type ChildProcess } from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/*why: * Seconds the group has to exit after SIGTERM before it is killed. */
const GRACE_SECONDS = 5;
const STDERR_TAIL = 2000;

// why: When the server exits, even by a crash, the pipe closes and the watcher ends the CLI's process group.
const WATCH_SCRIPT = [
  `{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep ${GRACE_SECONDS}; kill -KILL 0; } </dev/null >/dev/null 2>&1 &`,
  'exec "$@" 3<&-',
].join("\n");

export type ClaudeProcess = SpawnedProcess & {
  // why: Call this before closing the CLI's input: once the CLI exits, detached commands are no longer its descendants.
  stop(): Promise<void>;
  stderrTail(): string;
};

function signal(target: number, name: NodeJS.Signals) {
  try {
    process.kill(target, name);
  } catch {
    // why: Already gone.
  }
}

// why: Claude Code starts Bash commands detached, in a session of their own, so the CLI's group does not include them.
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

// why: Windows has no process groups. A killed CLI can leave the commands it detached.
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
    return Object.assign(child, { stop: async () => void child.kill(), stderrTail });
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
  child.once("exit", () => {
    exited = true;
    if (child.pid) signal(-child.pid, "SIGKILL");
  });
  const stop = () => (stopping ??= sweep());
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
  return Object.assign(child as ChildProcess & SpawnedProcess, { stop, stderrTail });
}
