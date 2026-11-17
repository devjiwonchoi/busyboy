import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, open, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { cookies } from 'next/headers'
import { unstable_rethrow } from 'next/navigation'
import { SERVER_TOKEN_ENV, TEST_MODE_ENV } from '@/lib/server-token'
import { pathKey } from './paths'
import { isThemeName, type ThemeName } from '@/lib/theme'
import type { ProviderId } from './runner/contract'

// The data folder is shared with the legacy app, which keeps its own files there.

export const HOME_ENV = 'BUSYBOY_HOME'

export { TEST_MODE_ENV }

export const TEST_HOME_COOKIE = 'busyboy-test-home'

/** Named so it never collides with the legacy app's `settings.json`. */
export const SETTINGS_FILE = 'app-settings.json'

export type ProjectEntry = {
  name: string
  path: string
  addedAt: string
}

export type ManagerEntry = {
  id: string
  name: string
  project: string
  createdAt: string
}

export type Settings = {
  version: number
  setupCompletedAt: string | null
  defaultProvider: ProviderId | null
  theme: ThemeName
  companion: string | null
  companionImage: string | null
  projects: ProjectEntry[]
  managers: ManagerEntry[]
  // Null until the user edits the list, so a newer BusyBoy's defaults still apply.
  alwaysAsk: string[] | null
  [unknownKey: string]: unknown
}

const EMPTY_SETTINGS: Settings = {
  version: 1,
  setupCompletedAt: null,
  defaultProvider: null,
  theme: 'dark',
  companion: null,
  companionImage: null,
  projects: [],
  managers: [],
  alwaysAsk: null,
}

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

export function resolveDataFolder(testHomeCookie?: string) {
  return testHome(testHomeCookie) ?? (process.env[HOME_ENV] || join(homedir(), '.busyboy'))
}

const BOUND_FOLDER_KEY = Symbol.for('busyboy.data-folder')
const boundStore = globalThis as typeof globalThis & { [BOUND_FOLDER_KEY]?: AsyncLocalStorage<string> }
const boundFolder = (boundStore[BOUND_FOLDER_KEY] ??= new AsyncLocalStorage<string>())

// Work that outlives a request has to capture the data folder, because the proxy has no cookies() later.
export function runWithDataFolder<T>(folder: string, work: () => T): T {
  return boundFolder.run(folder, work)
}

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
    defaultProvider: value.defaultProvider === 'claude' || value.defaultProvider === 'codex' || value.defaultProvider === 'grok' ? value.defaultProvider : null,
    theme: isThemeName(value.theme) ? value.theme : 'dark',
    companion: typeof value.companion === 'string' ? value.companion : null,
    companionImage: typeof value.companionImage === 'string' ? value.companionImage : null,
    projects: Array.isArray(value.projects)
      ? value.projects.filter(
          (project): project is ProjectEntry =>
            isRecord(project) && typeof project.name === 'string' && typeof project.path === 'string',
        )
      : [],
    managers: Array.isArray(value.managers)
      ? value.managers.filter(
          (manager): manager is ManagerEntry =>
            isRecord(manager) && typeof manager.id === 'string' && typeof manager.name === 'string' && typeof manager.project === 'string',
        )
      : [],
    alwaysAsk:
      Array.isArray(value.alwaysAsk) && value.alwaysAsk.every((rule) => typeof rule === 'string') ? value.alwaysAsk : null,
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

const WRITE_QUEUE_KEY = Symbol.for('busyboy.settings-writes')
const globalStore = globalThis as typeof globalThis & { [WRITE_QUEUE_KEY]?: Map<string, Promise<unknown>> }
const writeQueues = (globalStore[WRITE_QUEUE_KEY] ??= new Map())

function queued<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = pathKey(file)
  const next = (writeQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  writeQueues.set(key, next)
  return next
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function moveAsideIfCorrupt(folder: string) {
  const file = join(folder, SETTINGS_FILE)
  const text = await readSettingsFile(file)
  if (text === undefined || parseSettings(text)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let aside = join(folder, `app-settings.corrupt-${stamp}.json`)
  for (let n = 2; await exists(aside); n++) aside = join(folder, `app-settings.corrupt-${stamp}-${n}.json`)
  await rename(file, aside)
}

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

export function isSetupComplete(settings: Settings) {
  return Boolean(settings.setupCompletedAt)
}
