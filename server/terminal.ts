import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, type IPty } from 'node-pty'

/** Output kept per terminal so a reconnecting panel can redraw the screen. */
const SCROLLBACK_LIMIT = 256 * 1024
/** How long a terminal outlives its last output stream before it is killed. */
const DETACHED_GRACE_MS = 15_000
/** Waits between SIGHUP, SIGTERM, and SIGKILL when a shell will not exit. */
const KILL_ESCALATION_MS = 1_000
const MIN_SIZE = 2
const MAX_SIZE = 1000

export type TerminalEvent = { type: 'data'; data: string } | { type: 'exit'; exitCode: number; signal?: number }

type Listener = (event: TerminalEvent) => void

type Terminal = {
  id: string
  cwd: string
  shell: string
  pty: IPty
  scrollback: string
  exited: boolean
  listeners: Set<Listener>
  detachedTimer: ReturnType<typeof setTimeout> | null
}

type Registry = {
  terminals: Map<string, Terminal>
  /** Killed terminals whose process has not exited yet. */
  dying: Set<Terminal>
  exitHookInstalled: boolean
}

// Kept on globalThis so `next dev` reloads of this module reuse the same
// registry instead of orphaning live shells.
const registryKey = Symbol.for('busyboy.terminals')
const registry: Registry = ((globalThis as Record<symbol, unknown>)[registryKey] as Registry | undefined) ?? {
  terminals: new Map(),
  dying: new Set(),
  exitHookInstalled: false,
}
;(globalThis as Record<symbol, unknown>)[registryKey] = registry

/**
 * node-pty 1.1.0 publishes `spawn-helper` without the executable bit, and
 * copies of the package can drop it too. Without it every spawn on macOS and
 * Linux fails with `posix_spawnp failed`.
 *
 * Turbopack compiles `createRequire(import.meta.url).resolve()` into a module
 * id instead of a path, so resolve through the runtime's own module loader,
 * from the server's folder (the standalone server chdirs there; `next dev`
 * runs from the project root).
 */
let spawnHelperChecked = false
function ensureSpawnHelperExecutable() {
  if (spawnHelperChecked || process.platform === 'win32') return
  spawnHelperChecked = true
  try {
    const { createRequire } = process.getBuiltinModule('node:module')
    const packageDir = dirname(createRequire(join(process.cwd(), 'noop.js')).resolve('node-pty/package.json'))
    for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
      const helper = join(packageDir, dir, 'spawn-helper')
      if (!existsSync(helper)) continue
      if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
      return
    }
  } catch {
    // Spawning reports the real problem if the helper is unusable.
  }
}

/** The user's login shell and its arguments. */
export function loginShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'cmd.exe', args: [] }
  }
  const file = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  return { file, args: ['-l'] }
}

/** The shell sees the user's environment, not the variables that configure this server. */
function shellEnvironment(cwd: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // BUSYBOY_TOKEN, PORT, and HOSTNAME would let any program run in the shell
  // call this server as the app. Next's private variables do not belong there either.
  for (const key of ['PORT', 'HOSTNAME', 'NODE_ENV', 'NEXT_RUNTIME']) delete env[key]
  for (const key of Object.keys(env)) {
    if (key.startsWith('BUSYBOY_') || key.startsWith('__NEXT') || key.startsWith('NEXT_PRIVATE')) delete env[key]
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'busyboy'
  // Without a matching PWD, shells print the resolved path (/private/var/...)
  // instead of the folder they were opened in.
  env.PWD = cwd
  return env
}

function clampSize(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(value)))
}

function emit(terminal: Terminal, event: TerminalEvent) {
  for (const listener of terminal.listeners) listener(event)
}

function installExitHook() {
  if (registry.exitHookInstalled) return
  registry.exitHookInstalled = true
  process.once('exit', () => {
    killAllTerminals()
    // Nothing can wait any more; force whatever is still running.
    for (const terminal of registry.dying) signal(terminal, 'SIGKILL')
  })
  // On SIGTERM and SIGINT the Next server stops accepting connections and
  // waits for open requests before it exits. Output streams stay open while
  // their shell lives, so end the shells first or the server never exits.
  process.once('SIGTERM', killAllTerminals)
  process.once('SIGINT', killAllTerminals)
}

export type StartTerminalOptions = { cwd: string; cols: number; rows: number }

/** Starts the user's login shell in a pty. */
export function startTerminal({ cwd, cols, rows }: StartTerminalOptions) {
  ensureSpawnHelperExecutable()
  const shell = loginShell()
  const id = randomUUID()
  const process_ = spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cwd,
    cols: clampSize(cols, 80),
    rows: clampSize(rows, 24),
    env: shellEnvironment(cwd),
  })

  const terminal: Terminal = {
    id,
    cwd,
    shell: shell.file,
    pty: process_,
    scrollback: '',
    exited: false,
    listeners: new Set(),
    detachedTimer: null,
  }
  registry.terminals.set(id, terminal)
  installExitHook()

  process_.onData((data) => {
    terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_LIMIT)
    emit(terminal, { type: 'data', data })
  })
  process_.onExit(({ exitCode, signal }) => {
    terminal.exited = true
    registry.dying.delete(terminal)
    finish(terminal, { type: 'exit', exitCode, signal })
  })

  // Nobody is listening yet; do not keep a shell nobody ever attaches to.
  scheduleDetachedKill(terminal)
  return { id, cwd, shell: shell.file }
}

function scheduleDetachedKill(terminal: Terminal) {
  if (terminal.detachedTimer) clearTimeout(terminal.detachedTimer)
  terminal.detachedTimer = setTimeout(() => {
    if (terminal.listeners.size === 0) killTerminal(terminal.id)
  }, DETACHED_GRACE_MS)
}

/**
 * Follows a terminal's output. The listener first receives the scrollback so
 * a reconnecting panel can redraw. Returns a function that stops following;
 * when the last follower leaves, the terminal is killed after a grace period.
 */
export function attachTerminal(id: string, listener: Listener): (() => void) | null {
  const terminal = registry.terminals.get(id)
  if (!terminal) return null
  if (terminal.detachedTimer) {
    clearTimeout(terminal.detachedTimer)
    terminal.detachedTimer = null
  }
  if (terminal.scrollback) listener({ type: 'data', data: terminal.scrollback })
  terminal.listeners.add(listener)
  return () => {
    if (!terminal.listeners.delete(listener)) return
    if (terminal.listeners.size === 0 && registry.terminals.has(id)) scheduleDetachedKill(terminal)
  }
}

export function writeTerminal(id: string, data: string) {
  const terminal = registry.terminals.get(id)
  if (!terminal) return false
  terminal.pty.write(data)
  return true
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const terminal = registry.terminals.get(id)
  if (!terminal) return false
  terminal.pty.resize(clampSize(cols, terminal.pty.cols), clampSize(rows, terminal.pty.rows))
  return true
}

/** Removes the terminal and ends every output stream with its exit event. */
function finish(terminal: Terminal, event: Extract<TerminalEvent, { type: 'exit' }>) {
  if (terminal.detachedTimer) clearTimeout(terminal.detachedTimer)
  terminal.detachedTimer = null
  registry.terminals.delete(terminal.id)
  emit(terminal, event)
  terminal.listeners.clear()
}

function signal(terminal: Terminal, name?: 'SIGHUP' | 'SIGTERM' | 'SIGKILL') {
  if (terminal.exited) return
  try {
    // node-pty on Windows takes no signal; its kill ends the console's process tree.
    terminal.pty.kill(process.platform === 'win32' ? undefined : name)
  } catch {
    // Already gone.
  }
}

/**
 * Hangs up the shell like a closed terminal window (the shell passes SIGHUP
 * on to its jobs), then escalates to SIGTERM and SIGKILL if it keeps running.
 * Output streams end right away so nothing waits on a stubborn process.
 */
export function killTerminal(id: string) {
  const terminal = registry.terminals.get(id)
  if (!terminal) return false
  finish(terminal, { type: 'exit', exitCode: -1, signal: 1 })
  signal(terminal, 'SIGHUP')
  if (process.platform === 'win32' || terminal.exited) return true
  registry.dying.add(terminal)
  const escalate = (steps: Array<'SIGTERM' | 'SIGKILL'>) => {
    const [next, ...rest] = steps
    if (!next) return
    setTimeout(() => {
      if (terminal.exited) return
      signal(terminal, next)
      escalate(rest)
    }, KILL_ESCALATION_MS).unref()
  }
  escalate(['SIGTERM', 'SIGKILL'])
  return true
}

export function killAllTerminals() {
  for (const id of [...registry.terminals.keys()]) killTerminal(id)
}
