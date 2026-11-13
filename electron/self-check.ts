import { lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { ServerHandle } from './server-process'
import type { ShellPathResult } from './shell-env'

const FLAG = '--self-check'
const LOAD_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000
/** The whole check fails and exits after this, whatever is still pending. */
export const SELF_CHECK_TIMEOUT_MS = 90_000

/**
 * `--self-check` or `--self-check=<output path>`; returns the absolute output
 * path, or null when not set. A relative path resolves against the working
 * directory; without a path the result goes to the system temp directory.
 */
export function selfCheckOutputPath(argv: string[]): string | null {
  const arg = argv.find((value) => value === FLAG || value.startsWith(`${FLAG}=`))
  if (!arg) return null
  const value = arg.slice(FLAG.length + 1)
  return value ? resolve(value) : join(tmpdir(), 'busyboy-self-check.json')
}

/**
 * The self-check may run while the app is open, so it uses a throwaway
 * profile instead of sharing the user's cookies and storage. Call before ready.
 */
export function isolateSelfCheckProfile() {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'busyboy-self-check-')))
}

type FolderSnapshot = Map<string, string>

/** Size and modification time of every entry under `dir`, without following links. */
function snapshotFolder(dir: string): FolderSnapshot {
  const snapshot: FolderSnapshot = new Map()
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const stat = lstatSync(path)
      snapshot.set(path.slice(dir.length + 1), `${stat.size}:${stat.mtimeMs}`)
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return snapshot
}

function changedEntries(before: FolderSnapshot, after: FolderSnapshot) {
  const changed: string[] = []
  for (const [path, stamp] of after) if (before.get(path) !== stamp) changed.push(path)
  for (const path of before.keys()) if (!after.has(path)) changed.push(path)
  return changed
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

  let serverFolder: { dir: string; before: FolderSnapshot } | undefined

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
      const response = await fetch(server.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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
        sidebar: Boolean(document.querySelector('[data-slot="sidebar"]')),
        bottomPanel: Boolean(document.querySelector('[data-slot="bottom-panel"]')),
      })`)) as Record<string, unknown>
      result.details.page = page
      result.checks.pageLoaded = page.title === app.getName()
      result.checks.shellRendered = Boolean(page.shell && page.chatArea && page.sidebar && page.bottomPanel)
    },
    /** Call before the server starts; `recordServerFolderUnchanged` compares after it stops. */
    snapshotServerFolder(dir: string) {
      serverFolder = { dir, before: snapshotFolder(dir) }
    },
    /** The packaged server folder is read-only in practice (signed bundle, Program Files). */
    recordServerFolderUnchanged() {
      if (!serverFolder) return
      const changed = changedEntries(serverFolder.before, snapshotFolder(serverFolder.dir))
      result.checks.serverFolderUnchanged = changed.length === 0
      if (changed.length > 0) result.details.serverFolderChanges = changed.slice(0, 20)
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
      process.stdout.write(json)
      try {
        mkdirSync(dirname(outputPath), { recursive: true })
        writeFileSync(outputPath, json)
      } catch (error) {
        process.stderr.write(`Could not write the self-check result to ${outputPath}: ${String(error)}\n`)
        return false
      }
      return result.ok
    },
  }
}
