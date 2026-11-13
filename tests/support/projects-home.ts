import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext } from '@playwright/test'
import { createGitRepository, useTestHome } from './test-home'

/**
 * Gives this browser context its own data folder with setup complete and one
 * git repository per project name, so the main screen opens with those projects.
 */
export async function useProjectsHome(context: BrowserContext, baseURL: string, names: string[]) {
  const home = await useTestHome(context, baseURL)
  const projects = Object.fromEntries(names.map((name) => [name, createGitRepository(name)]))
  const settings = {
    version: 1,
    setupCompletedAt: new Date(0).toISOString(),
    defaultProvider: null,
    projects: names.map((name) => ({ name, path: projects[name], addedAt: new Date(0).toISOString() })),
  }
  writeFileSync(join(home, 'app-settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
  return { home, projects }
}
