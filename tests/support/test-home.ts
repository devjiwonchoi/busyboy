import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from '@playwright/test'

// Must match server/config.ts and server/providers.ts.
const TEST_HOME_COOKIE = 'busyboy-test-home'
const TEST_SIGN_IN_COOKIE = 'busyboy-test-sign-in'
const SETTINGS_FILE = 'app-settings.json'

export function createTempFolder(prefix: string) {
  return mkdtempSync(join(tmpdir(), `busyboy-e2e-${prefix}-`))
}

/** A new git repository with one commit. */
export function createGitRepository(name = 'repo') {
  const folder = join(createTempFolder(name), name)
  mkdirSync(folder)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(folder, 'README.md'), `# ${name}\n`)
  git('add', '.')
  git('-c', 'user.name=Busyboy Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Initial commit')
  return folder
}

/**
 * The data folder the server uses when a test sets no home of its own: setup
 * is complete with one project, so journeys that open the main screen land there.
 */
export function prepareDefaultHome(folder: string) {
  if (existsSync(join(folder, SETTINGS_FILE))) return
  mkdirSync(folder, { recursive: true })
  const project = join(folder, 'default-project')
  mkdirSync(project, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' })
  const settings = {
    version: 1,
    setupCompletedAt: new Date(0).toISOString(),
    defaultProvider: null,
    projects: [{ name: 'default-project', path: project, addedAt: new Date(0).toISOString() }],
  }
  writeFileSync(join(folder, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`)
}

type SignIn = 'signed-in' | 'signed-out' | 'not-installed' | 'unavailable'

/** Gives this browser context a fresh, empty data folder and optional sign-in states. */
export async function useTestHome(
  context: BrowserContext,
  baseURL: string,
  signIn: Partial<Record<'claude' | 'codex', SignIn>> = {},
) {
  const home = createTempFolder('home')
  const cookies = [{ name: TEST_HOME_COOKIE, value: encodeURIComponent(home), url: baseURL }]
  const states = Object.entries(signIn).map(([provider, state]) => `${provider}=${state}`)
  if (states.length) cookies.push({ name: TEST_SIGN_IN_COOKIE, value: states.join(','), url: baseURL })
  await context.addCookies(cookies)
  return home
}

export function removeFolder(folder: string) {
  rmSync(folder, { recursive: true, force: true })
}
