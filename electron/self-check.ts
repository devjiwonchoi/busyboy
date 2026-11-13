import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { SERVER_TOKEN_HEADER } from '../lib/server-token'
import type { ServerHandle } from './server-process'
import type { ShellPathResult } from './shell-env'

const FLAG = '--self-check'
const LOAD_TIMEOUT_MS = 30_000
const TERMINAL_TIMEOUT_MS = 20_000
const TERMINAL_MARKER = 'busyboy-terminal-ok'

// The typed command differs from its output (quotes on Unix shells, a caret
// escape in cmd.exe), so the shell's echo of the input cannot match by itself.
const terminalCommand = process.platform === 'win32' ? 'echo busyboy-terminal^-ok\r' : `echo busyboy-"terminal"-ok\r`

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-_]/g, '')
}

/** Starts a pty through the server, runs `echo`, and returns what the shell printed. */
async function runTerminalEcho(server: ServerHandle) {
  const headers = { [SERVER_TOKEN_HEADER]: server.token, 'Content-Type': 'application/json' }
  const started = await fetch(`${server.url}/api/terminal`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cols: 120, rows: 30 }),
  })
  const body = (await started.json()) as { id?: string; cwd?: string; shell?: string; error?: string }
  if (!started.ok || !body.id) throw new Error(body.error ?? `Starting a terminal failed with HTTP ${started.status}.`)
  const endpoint = `${server.url}/api/terminal/${body.id}`

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TERMINAL_TIMEOUT_MS)
  let output = ''
  try {
    const stream = await fetch(endpoint, { headers, signal: abort.signal })
    if (!stream.ok || !stream.body) throw new Error(`Following the terminal failed with HTTP ${stream.status}.`)
    await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ input: terminalCommand }) })
    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ''
    while (!stripAnsi(output).split(/\r?\n/).some((line) => line.trim() === TERMINAL_MARKER)) {
      const { value, done } = await reader.read()
      if (done) break
      pending += value
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const event = JSON.parse(line) as { type: string; data?: string }
        if (event.type === 'data') output += event.data
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    abort.abort()
    await fetch(endpoint, { method: 'DELETE', headers }).catch(() => {})
  }
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim())
  return { cwd: body.cwd, shell: body.shell, printed: lines.includes(TERMINAL_MARKER), tail: lines.slice(-5) }
}

/** `--self-check` or `--self-check=<output path>`; returns the output path, or null when not set. */
export function selfCheckOutputPath(argv: string[]): string | null {
  const arg = argv.find((value) => value === FLAG || value.startsWith(`${FLAG}=`))
  if (!arg) return null
  const value = arg.slice(FLAG.length + 1)
  return value || join(app.getPath('userData'), 'self-check.json')
}

export type SelfCheckResult = {
  ok: boolean
  startedAt: string
  durationMs: number
  versions: { app: string; electron: string; chrome: string; node: string; platform: string; arch: string }
  checks: Record<string, boolean>
  details: Record<string, unknown>
  error?: string
}

export function createSelfCheck() {
  const started = Date.now()
  const result: SelfCheckResult = {
    ok: false,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    checks: {},
    details: {},
  }

  return {
    result,
    recordShellPath(shellPath: ShellPathResult) {
      result.checks.shellPathResolved = shellPath.source === 'login-shell' || process.platform === 'win32'
      result.details.shellPath = shellPath
    },
    async recordServer(server: ServerHandle) {
      result.checks.serverStarted = server.isRunning()
      result.details.serverUrl = server.url
      // A request without the token must be refused.
      const response = await fetch(server.url)
      await response.body?.cancel()
      result.checks.serverRejectsMissingToken = response.status === 403
    },
    async recordPage(window: BrowserWindow) {
      const contents = window.webContents
      if (contents.isLoading()) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The page did not load in time.')), LOAD_TIMEOUT_MS)
          contents.once('did-finish-load', () => {
            clearTimeout(timer)
            resolve()
          })
          contents.once('did-fail-load', (_event, code, description) => {
            clearTimeout(timer)
            reject(new Error(`The page failed to load: ${code} ${description}`))
          })
        })
      }
      const page = (await contents.executeJavaScript(`({
        title: document.title,
        shell: Boolean(document.querySelector('[data-slot="app-shell"]')),
        chatArea: Boolean(document.querySelector('[data-slot="chat-area"]')),
        sidebar: Boolean(document.querySelector('[data-slot="right-sidebar"]')),
        bottomPanel: Boolean(document.querySelector('[data-slot="bottom-panel"]')),
      })`)) as Record<string, unknown>
      result.details.page = page
      result.checks.pageLoaded = page.title === 'Busyboy'
      result.checks.shellRendered = Boolean(page.shell && page.chatArea && page.sidebar && page.bottomPanel)
    },
    async recordTerminal(server: ServerHandle) {
      const terminal = await runTerminalEcho(server)
      result.details.terminal = terminal
      result.checks.terminalEchoed = terminal.printed
    },
    async recordServerStop(server: ServerHandle) {
      await server.stop()
      result.checks.serverStopped = !server.isRunning()
    },
    fail(error: unknown) {
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    },
    write(outputPath: string) {
      result.durationMs = Date.now() - started
      result.ok = !result.error && Object.keys(result.checks).length > 0 && Object.values(result.checks).every(Boolean)
      const json = `${JSON.stringify(result, null, 2)}\n`
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, json)
      process.stdout.write(json)
      return result.ok
    },
  }
}
