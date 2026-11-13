import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

/** Seconds the group has to exit after SIGTERM before it is killed. */
const GRACE_SECONDS = 5
/** Characters of stderr kept to explain a CLI that fails. */
const STDERR_TAIL = 2000

// Runs as the leader of a new process group, so the CLI and what it starts in
// the group (MCP servers, for example) share one group id. A watcher in the
// group blocks on fd 3, a pipe whose other end only this server holds. When the
// server exits for any reason, crashes included, the pipe closes, the read
// returns, and the watcher ends the whole group. `exec` keeps the group leader's
// pid for the CLI, and the CLI does not inherit fd 3.
const WATCH_SCRIPT = [
  `{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep ${GRACE_SECONDS}; kill -KILL 0; } </dev/null >/dev/null 2>&1 &`,
  'exec "$@" 3<&-',
].join('\n')

export type ClaudeProcess = SpawnedProcess & {
  /**
   * Ends the CLI and everything it started. Resolves once the commands it
   * detached have been found and signaled; call it before closing the CLI's
   * input, because once the CLI exits they are no longer its descendants.
   */
  stop(): Promise<void>
  /** The end of what the CLI wrote to stderr. */
  stderrTail(): string
}

function signal(target: number, name: NodeJS.Signals) {
  try {
    process.kill(target, name)
  } catch {
    // Already gone.
  }
}

/**
 * Processes below `root` that lead their own group. Claude Code starts its Bash
 * commands, hooks, and background shells detached, in a session of their own,
 * so the CLI's group does not include them; while the CLI runs they are still
 * its descendants.
 */
function detachedDescendants(root: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve([])
      const children = new Map<number, { pid: number; pgid: number }[]>()
      for (const line of stdout.split('\n')) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
        if (!pid || !ppid || !pgid) continue
        children.set(ppid, [...(children.get(ppid) ?? []), { pid, pgid }])
      }
      const leaders: number[] = []
      const queue = [root]
      while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
          if (child.pgid === child.pid) leaders.push(child.pid)
          queue.push(child.pid)
        }
      }
      resolve(leaders)
    })
  })
}

/**
 * Spawns the Claude CLI for the Agent SDK's `spawnClaudeCodeProcess`. On macOS
 * and Linux the CLI leads its own process group:
 * - When the CLI exits, its group is killed.
 * - `stop` first ends the groups the CLI detached (Bash commands, background
 *   shells), then its own group.
 * - When this server exits or crashes, the watcher ends the CLI's group. The
 *   CLI then ends the commands it detached itself; if it is killed before it
 *   can, those can survive.
 * Windows has no process groups; there the CLI is spawned directly. stderr is
 * always read, so a chatty CLI never blocks on a full pipe.
 */
export function spawnClaudeProcess(options: SpawnOptions): ClaudeProcess {
  // Node types `env` without undefined values; the SDK's may hold them, and Node skips them.
  const env = options.env as NodeJS.ProcessEnv
  let tail = ''
  const readStderr = (child: ChildProcess) =>
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (tail = (tail + chunk).slice(-STDERR_TAIL)))
  const stderrTail = () => tail.trim()

  if (process.platform === 'win32') {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    readStderr(child)
    return Object.assign(child, { stop: async () => void child.kill(), stderrTail })
  }

  const child: ChildProcess = spawn('/bin/sh', ['-c', WATCH_SCRIPT, 'busyboy-claude', options.command, ...options.args], {
    cwd: options.cwd,
    env,
    signal: options.signal,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  readStderr(child)
  let exited = false
  let stopping: Promise<void> | undefined
  // Once the CLI has exited its pid can be reused, so its group is killed only
  // here, while the watcher still holds the group id.
  child.once('exit', () => {
    exited = true
    if (child.pid) signal(-child.pid, 'SIGKILL')
  })
  // A second stop waits for the first one's sweep instead of racing past it.
  const stop = () => (stopping ??= sweep())
  const sweep = async () => {
    if (exited || !child.pid) return
    const pid = child.pid
    const leaders = await detachedDescendants(pid)
    for (const leader of leaders) signal(-leader, 'SIGTERM')
    if (!exited) signal(-pid, 'SIGTERM')
    setTimeout(() => {
      for (const leader of leaders) signal(-leader, 'SIGKILL')
      if (!exited) signal(-pid, 'SIGKILL')
    }, GRACE_SECONDS * 1000).unref()
  }
  // With four stdio entries Node types stdin and stdout as nullable; both are pipes.
  return Object.assign(child as ChildProcess & SpawnedProcess, { stop, stderrTail })
}
