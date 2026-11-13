import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  version: 1
  /** Set when the user finishes setup with "Start chatting". */
  setupCompletedAt: string | null
  /** Used when more than one provider is signed in. */
  defaultProvider: ProviderId | null
  projects: ProjectEntry[]
}

const EMPTY_SETTINGS: Settings = { version: 1, setupCompletedAt: null, defaultProvider: null, projects: [] }

export function isTestMode() {
  return process.env[TEST_MODE_ENV] === '1'
}

/** The data folder, given the test-home cookie value when there is one (the proxy has no `cookies()`). */
export function resolveDataFolder(testHomeCookie?: string) {
  if (isTestMode() && testHomeCookie) return decodeURIComponent(testHomeCookie)
  return process.env[HOME_ENV] || join(homedir(), '.busyboy')
}

/**
 * The data folder for the current request. In test mode it reads a cookie,
 * so call it only inside a request (pages after `connection()`, actions, routes).
 */
export async function dataFolder() {
  if (!isTestMode()) return resolveDataFolder()
  return resolveDataFolder((await cookies()).get(TEST_HOME_COOKIE)?.value)
}

function parseSettings(text: string): Settings {
  const value = JSON.parse(text) as Partial<Settings>
  return {
    version: 1,
    setupCompletedAt: typeof value.setupCompletedAt === 'string' ? value.setupCompletedAt : null,
    defaultProvider: value.defaultProvider === 'claude' || value.defaultProvider === 'codex' ? value.defaultProvider : null,
    projects: Array.isArray(value.projects)
      ? value.projects.filter(
          (project): project is ProjectEntry =>
            typeof project?.name === 'string' && typeof project?.path === 'string',
        )
      : [],
  }
}

/** Reads the settings in `folder`. A missing file means nothing is set up yet. */
export async function readSettingsAt(folder: string): Promise<Settings> {
  try {
    return parseSettings(await readFile(join(folder, SETTINGS_FILE), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_SETTINGS)
    throw error
  }
}

export async function readSettings() {
  return readSettingsAt(await dataFolder())
}

// Updates to one settings file run one at a time, so concurrent actions do
// not overwrite each other's changes.
const WRITE_QUEUE_KEY = Symbol.for('busyboy.settings-writes')
const globalStore = globalThis as typeof globalThis & { [WRITE_QUEUE_KEY]?: Map<string, Promise<unknown>> }
const writeQueues = (globalStore[WRITE_QUEUE_KEY] ??= new Map())

/**
 * Applies `change` to the settings and saves them. Creates the data folder and
 * the settings file only when they are missing, and writes nothing else.
 */
export async function updateSettings<T>(change: (settings: Settings) => T | Promise<T>): Promise<T> {
  const folder = await dataFolder()
  const file = join(folder, SETTINGS_FILE)
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    const settings = await readSettingsAt(folder)
    const result = await change(settings)
    await mkdir(folder, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`)
    await rename(temporary, file)
    return result
  })
  writeQueues.set(file, next)
  return next
}

/** Setup is complete once the user finished it and at least one project remains. */
export function isSetupComplete(settings: Settings) {
  return Boolean(settings.setupCompletedAt) && settings.projects.length > 0
}
