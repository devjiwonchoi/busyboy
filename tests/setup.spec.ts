import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createGitRepository, createTempFolder, removeFolder, useTestHome } from './support/test-home'

const folders: string[] = []

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder)
})

function track(folder: string) {
  folders.push(folder)
  return folder
}

/** A repository lives in its own temporary parent folder; remove both. */
function trackRepository(repository: string) {
  folders.push(dirname(repository))
  return repository
}

async function addFolder(page: Page, folder: string) {
  await page.getByLabel('Folder path').fill(folder)
  await page.getByRole('button', { name: 'Add folder' }).click()
}

test('finishing setup should open the main screen', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in', codex: 'signed-out' }))
  const repository = trackRepository(createGitRepository('shop'))

  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)

  const providers = page.getByRole('list', { name: 'Providers' })
  await expect(providers.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('Signed in')
  await expect(providers.getByRole('listitem').filter({ hasText: 'Codex' })).toContainText('Signed out')
  await expect(page.getByLabel('Codex login command')).toHaveText('codex login')

  const start = page.getByRole('button', { name: 'Start chatting' })
  await expect(start).toBeDisabled()
  await expect(page.getByText('Add a project to continue.')).toBeVisible()

  await addFolder(page, repository)
  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects).toContainText('shop')

  await expect(start).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('setup.png'), fullPage: true })
  await start.click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible()
})

test('adding a folder that is not a git repository should show an error', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!))
  const folder = track(createTempFolder('plain'))

  await page.goto('/setup')
  await addFolder(page, folder)

  await expect(page.getByRole('alert').filter({ hasText: folder })).toHaveText(
    `${folder} is not a git repository. Run git init there, or choose another folder.`,
  )
  await expect(page.getByText('No projects yet.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeDisabled()
})

test('opening the app after setup should skip setup', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const repository = trackRepository(createGitRepository('api'))

  await page.goto('/setup')
  await addFolder(page, repository)
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('api')
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible()

  const reopened = await context.newPage()
  await reopened.goto('/')
  await expect(reopened).toHaveURL(/\/$/)
  await expect(reopened.getByRole('main', { name: 'Chat' })).toBeVisible()

  await reopened.getByRole('link', { name: 'Setup' }).click()
  await expect(reopened).toHaveURL(/\/setup$/)
  await expect(reopened.getByRole('list', { name: 'Projects' })).toContainText('api')
})

test('removing a project should keep its folder', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!))
  const repository = trackRepository(createGitRepository('web'))

  await page.goto('/setup')
  await addFolder(page, repository)
  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects).toContainText('web')

  await projects.getByRole('button', { name: 'Remove web' }).click()

  await expect(page.getByText('No projects yet.')).toBeVisible()
  expect(existsSync(join(repository, '.git'))).toBe(true)
  expect(existsSync(join(repository, 'README.md'))).toBe(true)
})

test('opening the app with a corrupt settings file should show setup again', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const corrupt = '{"setupCompletedAt": "2026-11-14T00:00:00.000Z", "projects": ['
  writeFileSync(join(home, 'app-settings.json'), corrupt)
  const repository = trackRepository(createGitRepository('docs'))

  await page.goto('/')

  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByText('No projects yet.')).toBeVisible()
  const moved = readdirSync(home).filter((name) => /^app-settings\.corrupt-.+\.json$/.test(name))
  expect(moved).toHaveLength(1)
  expect(readFileSync(join(home, moved[0]), 'utf8')).toBe(corrupt)

  await addFolder(page, repository)
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('docs')
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible()
})

test('adding a folder named @scope should add the project', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!))
  const repository = trackRepository(createGitRepository('@scope'))

  await page.goto('/setup')
  await addFolder(page, repository)

  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects.getByText('scope', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'project name' })).toBeHidden()
})

test('going back from setup after signing out should open the main screen', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const repository = trackRepository(createGitRepository('mobile'))

  await page.goto('/setup')
  await addFolder(page, repository)
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('mobile')
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible()

  await context.addCookies([{ name: 'busyboy-test-sign-in', value: 'claude=signed-out', url: baseURL! }])
  await page.getByRole('link', { name: 'Setup' }).click()
  await expect(page.getByRole('list', { name: 'Providers' })).toContainText('Signed out')

  await page.getByRole('link', { name: 'Back to chat' }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible()
})
