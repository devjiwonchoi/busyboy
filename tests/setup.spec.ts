import { existsSync } from 'node:fs'
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

test('adding a folder named @scope should add the project', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!))
  const repository = trackRepository(createGitRepository('@scope'))

  await page.goto('/setup')
  await addFolder(page, repository)

  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects.getByText('scope', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'project name' })).toBeHidden()
})
