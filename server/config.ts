import { access, mkdir, open, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { cookies } from 'next/headers'
import type { ProviderId } from './runner/contract'

// The data folder is shared with the legacy app, which keeps its own files
// there (worktrees, SQLite state, settings). Busyboy only ever touches the
// files it creates itself, starting with SETTINGS_FILE.

/** Overrides the data folder (`~/.busyboy` by default). */
export const HOME_ENV = 'BUSYBOY_HOME'

/** Set to `1` by the Playwright config. Enables the test cookies below. */
export const TEST_MODE_ENV = 'BUSYBOY_TEST_MODE'

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
  /** 1 for files this version writes. A higher version from a newer busyboy is kept as is. */
  version: number
  /** Set when the user finishes setup with "Start chatting". */
  setupCompletedAt: string | null
  /** Used when more than one provider is signed in. */
  defaultProvider: ProviderId | null
  projects: ProjectEntry[]
  /** Keys this version does not know are kept when saving. */
  [unknownKey: string]: unknown
}

const EMPTY_SETTINGS: Settings = { version: 1, setupCompletedAt: null, defaultProvider: null, projects: [] }

/** Test mode never applies to the desktop app, which always starts the server with a token. */
export function isTestMode() {
  return process.env[TEST_MODE_ENV] === '1' && !process.env.BUSYBOY_TOKEN
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

/**
 * The data folder for the current request. In test mode it reads a cookie,
 * so call it only inside a request (pages after `connection()`, actions, routes).
 */
export async function dataFolder() {
  if (!isTestMode()) return resolveDataFolder()
  return resolveDataFolder((await cookies()).get(TEST_HOME_COOKIE)?.value)
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

/** Setup is complete once the user finished it and at least one project remains. */
export function isSetupComplete(settings: Settings) {
  return Boolean(settings.setupCompletedAt) && settings.projects.length > 0
}
