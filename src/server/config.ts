import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, open, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { cookies } from 'next/headers'
import { unstable_rethrow } from 'next/navigation'
import { SERVER_TOKEN_ENV, TEST_MODE_ENV } from '@/lib/server-token'
import type { ProviderId } from './runner/contract'

// The data folder is shared with the legacy app, which keeps its own files
// there (worktrees, SQLite state, settings). BusyBoy only ever touches the
// files it creates itself, starting with SETTINGS_FILE.

/** Overrides the data folder (`~/.busyboy` by default). */
export const HOME_ENV = 'BUSYBOY_HOME'

export { TEST_MODE_ENV }

/** Test mode only: a data folder for this browser context, so journeys run in parallel. */
export const TEST_HOME_COOKIE = 'busyboy-test-home'

/** Named so it never collides with the legacy app's `settings.json`. */
export const SETTINGS_FILE = 'app-settings.json'

export type ProjectEntry = {
  name: string
  /** Absolute path of the git repository's top-level folder. */
  path: string
  addedAt: string
}

export type Settings = {
  /** 1 for files this version writes. A higher version from a newer BusyBoy is kept as is. */
  version: number
  /** Set when the user finishes setup. Projects are optional; the Director asks for a folder when a task needs one. */
  setupCompletedAt: string | null
  /** Used when more than one provider is signed in. */
  defaultProvider: ProviderId | null
  /** The companion id the user picked in setup (see server/companions.ts). */
  companion: string | null
  /** File name of the user's own companion picture inside the data folder. */
  companionImage: string | null
  projects: ProjectEntry[]
  /** Keys this version does not know are kept when saving. */
  [unknownKey: string]: unknown
}

const EMPTY_SETTINGS: Settings = {
  version: 1,
  setupCompletedAt: null,
  defaultProvider: null,
  companion: null,
  companionImage: null,
  projects: [],
}

/** Test mode never applies to the desktop app, which always starts the server with a token. */
export function isTestMode() {
  return process.env[TEST_MODE_ENV] === '1' && !process.env[SERVER_TOKEN_ENV]
}

function testHome(cookie: string | undefined) {
  if (!cookie || !isTestMode()) return undefined
  try {
    const folder = decodeURIComponent(cookie)
    return isAbsolute(folder) ? folder : undefined
  } catch {
    return undefined
  }
}

/** The data folder, given the test-home cookie value when there is one (the proxy has no `cookies()`). */
export function resolveDataFolder(testHomeCookie?: string) {
  return testHome(testHomeCookie) ?? (process.env[HOME_ENV] || join(homedir(), '.busyboy'))
}

const BOUND_FOLDER_KEY = Symbol.for('busyboy.data-folder')
const boundStore = globalThis as typeof globalThis & { [BOUND_FOLDER_KEY]?: AsyncLocalStorage<string> }
const boundFolder = (boundStore[BOUND_FOLDER_KEY] ??= new AsyncLocalStorage<string>())

/**
 * Runs `work` with a fixed data folder. Work that outlives a request (agent
 * callbacks, background jobs) captures `await dataFolder()` during the
 * request and runs inside this, so tests and the app use the same folder.
 */
export function runWithDataFolder<T>(folder: string, work: () => T): T {
  return boundFolder.run(folder, work)
}

/**
 * The data folder. In test mode it comes from the request's cookie; outside
 * a request (and outside `runWithDataFolder`) it falls back to the default.
 */
export async function dataFolder() {
  const bound = boundFolder.getStore()
  if (bound) return bound
  if (!isTestMode()) return resolveDataFolder()
  try {
    return resolveDataFolder((await cookies()).get(TEST_HOME_COOKIE)?.value)
  } catch (error) {
    unstable_rethrow(error)
    return resolveDataFolder()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns the settings, or undefined when the text is not a settings object. */
function parseSettings(text: string): Settings | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  return {
    ...value,
    version: typeof value.version === 'number' && value.version > 1 ? value.version : 1,
    setupCompletedAt: typeof value.setupCompletedAt === 'string' ? value.setupCompletedAt : null,
    defaultProvider: value.defaultProvider === 'claude' || value.defaultProvider === 'codex' ? value.defaultProvider : null,
    companion: typeof value.companion === 'string' ? value.companion : null,
    companionImage: typeof value.companionImage === 'string' ? value.companionImage : null,
    projects: Array.isArray(value.projects)
      ? value.projects.filter(
          (project): project is ProjectEntry =>
            isRecord(project) && typeof project.name === 'string' && typeof project.path === 'string',
        )
      : [],
  }
}

async function readSettingsFile(file: string) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Changes to one settings file run one at a time, so concurrent actions do
// not overwrite each other's changes.
const WRITE_QUEUE_KEY = Symbol.for('busyboy.settings-writes')
const globalStore = globalThis as typeof globalThis & { [WRITE_QUEUE_KEY]?: Map<string, Promise<unknown>> }
const writeQueues = (globalStore[WRITE_QUEUE_KEY] ??= new Map())

function queued<T>(file: string, work: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(file) ?? Promise.resolve()).catch(() => {}).then(work)
  writeQueues.set(file, next)
  return next
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** Moves an unreadable settings file aside to a new name, so setup can run again. Call it inside the queue. */
async function moveAsideIfCorrupt(folder: string) {
  const file = join(folder, SETTINGS_FILE)
  // Checked again here, so a file that a concurrent save just replaced is never moved.
  const text = await readSettingsFile(file)
  if (text === undefined || parseSettings(text)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let aside = join(folder, `app-settings.corrupt-${stamp}.json`)
  for (let n = 2; await exists(aside); n++) aside = join(folder, `app-settings.corrupt-${stamp}-${n}.json`)
  await rename(file, aside)
}

/**
 * Reads the settings in `folder`. A missing file means nothing is set up yet.
 * An unreadable file is moved aside and reads as nothing set up.
 */
export async function readSettingsAt(folder: string): Promise<Settings> {
  const text = await readSettingsFile(join(folder, SETTINGS_FILE))
  const settings = text === undefined ? undefined : parseSettings(text)
  if (settings) return settings
  if (text !== undefined) {
    const file = join(folder, SETTINGS_FILE)
    await queued(file, () => moveAsideIfCorrupt(folder))
  }
  return structuredClone(EMPTY_SETTINGS)
}

export async function readSettings() {
  return readSettingsAt(await dataFolder())
}

/**
 * Applies `change` to the settings and saves them. Creates the data folder and
 * the settings file only when they are missing, and writes nothing else.
 */
export async function updateSettings<T>(change: (settings: Settings) => T | Promise<T>): Promise<T> {
  const folder = await dataFolder()
  const file = join(folder, SETTINGS_FILE)
  return queued(file, async () => {
    await moveAsideIfCorrupt(folder)
    const text = await readSettingsFile(file)
    const settings = (text === undefined ? undefined : parseSettings(text)) ?? structuredClone(EMPTY_SETTINGS)
    const result = await change(settings)
    await mkdir(folder, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    return result
  })
}

/** Setup is complete once the user finished it. Starting without a project is allowed. */
export function isSetupComplete(settings: Settings) {
  return Boolean(settings.setupCompletedAt)
}
