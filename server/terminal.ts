import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { onServerShutdown } from './shutdown'
import { isTestMode } from './working-directory'

/** Output kept per terminal so a reconnecting panel can redraw the screen. */
const SCROLLBACK_LIMIT = 256 * 1024
/** How long a terminal outlives its last output stream before it is killed. */
const DETACHED_GRACE_MS = 15_000
/** Waits between SIGHUP, SIGTERM, and SIGKILL when a shell will not exit. */
const KILL_ESCALATION_MS = 1_000
/** How long a server shutdown waits for shells to exit. */
const STOP_ALL_TIMEOUT_MS = 3_000
const MIN_SIZE = 2
const MAX_SIZE = 1000

export type TerminalEvent =
  | { type: 'data'; data: string }
  /** `killed` is set when Busyboy ended the shell rather than the shell exiting by itself. */
  | { type: 'exit'; exitCode: number; signal?: number; killed?: boolean }

type Listener = (event: TerminalEvent) => void

type Terminal = {
  id: string
  cwd: string
  shell: string
  pty: IPty
  /** Recent output chunks, whole, so replay never starts inside an escape sequence. */
  scrollback: string[]
  scrollbackLength: number
  exited: boolean
  /** Set when the shell exited by itself; kept briefly so a late follower still sees it. */
  exit: Extract<TerminalEvent, { type: 'exit' }> | null
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

/** The account's shell from the user database; `userInfo()` throws when the uid has no entry. */
function accountShell() {
  try {
    return userInfo().shell
  } catch {
    return null
  }
}

/**
 * The user's login shell and its arguments. Journeys pin a plain shell with
 * BUSYBOY_TEST_SHELL (test mode only) so the developer's profile cannot
 * change what they see.
 */
export function loginShell(): { file: string; args: string[] } {
  const testShell = process.env.BUSYBOY_TEST_SHELL
  if (testShell && isTestMode()) return { file: testShell, args: [] }
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'cmd.exe', args: [] }
  }
  const file = process.env.SHELL || accountShell() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
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
    // Shells already past their hangup get forced; the rest get the hangup
    // now, so they can still pass it on to their jobs.
    const stubborn = [...registry.dying]
    killAllTerminals()
    for (const terminal of stubborn) signal(terminal, 'SIGKILL')
  })
  // On SIGTERM and SIGINT the Next server stops accepting connections and
  // waits for open requests before it exits. Output streams stay open while
  // their shell lives, so end the shells first or the server never exits.
  process.once('SIGTERM', killAllTerminals)
  process.once('SIGINT', killAllTerminals)
  // The desktop app asks before it stops the server (on Windows it then
  // terminates the process, which runs none of the hooks above).
  onServerShutdown(stopAllTerminals)
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
    scrollback: [],
    scrollbackLength: 0,
    exited: false,
    exit: null,
    listeners: new Set(),
    detachedTimer: null,
  }
  registry.terminals.set(id, terminal)
  installExitHook()

  process_.onData((data) => {
    terminal.scrollback.push(data)
    terminal.scrollbackLength += data.length
    while (terminal.scrollbackLength > SCROLLBACK_LIMIT && terminal.scrollback.length > 1) {
      terminal.scrollbackLength -= terminal.scrollback.shift()!.length
    }
    emit(terminal, { type: 'data', data })
  })
  process_.onExit(({ exitCode, signal }) => {
    terminal.exited = true
    registry.dying.delete(terminal)
    // A killed terminal already left the registry and ended its streams.
    if (registry.terminals.get(id) !== terminal) return
    terminal.exit = { type: 'exit', exitCode, signal }
    emit(terminal, terminal.exit)
    terminal.listeners.clear()
    // Keep the output and exit status for a while: a shell that fails right
    // away (a bad $SHELL, a profile that exits) can do so before the panel
    // attaches, and the panel should still show what it printed and its code.
    if (terminal.detachedTimer) clearTimeout(terminal.detachedTimer)
    terminal.detachedTimer = setTimeout(() => forget(terminal), DETACHED_GRACE_MS)
  })

  // Nobody is listening yet; do not keep a shell nobody ever attaches to.
  scheduleDetachedKill(terminal)
  return { id, cwd, shell: shell.file, pid: process_.pid }
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
  const replay = () => {
    if (terminal.scrollback.length > 0) listener({ type: 'data', data: terminal.scrollback.join('') })
  }
  // An exited terminal replays and keeps its expiry; nothing is left to follow.
  if (terminal.exit) {
    replay()
    listener(terminal.exit)
    return () => {}
  }
  if (terminal.detachedTimer) {
    clearTimeout(terminal.detachedTimer)
    terminal.detachedTimer = null
  }
  replay()
  terminal.listeners.add(listener)
  return () => {
    if (!terminal.listeners.delete(listener)) return
    if (terminal.listeners.size === 0 && registry.terminals.has(id)) scheduleDetachedKill(terminal)
  }
}

/** Runs `action` on a live pty; false when the terminal is gone or its pty just closed. */
function withLivePty(id: string, action: (pty: IPty) => void) {
  const terminal = registry.terminals.get(id)
  if (!terminal || terminal.exited) return false
  try {
    action(terminal.pty)
    return true
  } catch {
    return false
  }
}

export function writeTerminal(id: string, data: string) {
  return withLivePty(id, (pty) => pty.write(data))
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  return withLivePty(id, (pty) => pty.resize(clampSize(cols, pty.cols), clampSize(rows, pty.rows)))
}

function forget(terminal: Terminal) {
  if (terminal.detachedTimer) clearTimeout(terminal.detachedTimer)
  terminal.detachedTimer = null
  if (registry.terminals.get(terminal.id) === terminal) registry.terminals.delete(terminal.id)
}

/** Removes the terminal and ends every output stream with its exit event. */
function finish(terminal: Terminal, event: Extract<TerminalEvent, { type: 'exit' }>) {
  forget(terminal)
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
  if (terminal.exited) {
    forget(terminal)
    return true
  }
  finish(terminal, { type: 'exit', exitCode: -1, killed: true })
  signal(terminal, 'SIGHUP')
  registry.dying.add(terminal)
  if (process.platform === 'win32') return true
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
  for (const [id, terminal] of [...registry.terminals]) {
    if (!terminal.exited) killTerminal(id)
  }
}

/** Kills every terminal and waits, up to a limit, for their processes to exit. */
async function stopAllTerminals() {
  killAllTerminals()
  const deadline = Date.now() + STOP_ALL_TIMEOUT_MS
  while (registry.dying.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
