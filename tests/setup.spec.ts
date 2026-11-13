import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

async function addFolder(page: Page, folder: string) {
  await page.getByLabel('Folder path').fill(folder)
  await page.getByRole('button', { name: 'Add folder' }).click()
}

test('finishing setup should open the main screen', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in', codex: 'signed-out' }))
  const repository = track(createGitRepository('shop'))

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
  const repository = track(createGitRepository('api'))

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
  const repository = track(createGitRepository('web'))

  await page.goto('/setup')
  await addFolder(page, repository)
  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects).toContainText('web')

  await projects.getByRole('button', { name: 'Remove web' }).click()

  await expect(page.getByText('No projects yet.')).toBeVisible()
  expect(existsSync(join(repository, '.git'))).toBe(true)
  expect(existsSync(join(repository, 'README.md'))).toBe(true)
})
