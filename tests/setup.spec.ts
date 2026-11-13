import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createGitRepository, createTempFolder, removeFolder, useTestHome } from './support/test-home'

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

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

function readSettings(home: string) {
  return JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8'))
}

async function chooseCompanion(page: Page, name: string) {
  await page.getByRole('radio', { name: new RegExp(`^${name} the`) }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to an agent' })).toBeVisible()
}

/** From the companion step to the start step, skipping skills. */
async function goToStart(page: Page, companion = 'Nori') {
  await page.goto('/setup')
  await chooseCompanion(page, companion)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('link', { name: 'Skip' }).click()
  await expect(page.getByRole('heading', { name: 'Add projects' })).toBeVisible()
}

async function typeFolder(page: Page, folder: string) {
  await page.getByLabel('Folder path').fill(folder)
  await page.getByRole('button', { name: 'Add folder' }).click()
}

test('continuing without a signed-in agent should not be possible', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-out', codex: 'signed-out' }))

  await page.goto('/setup')
  await chooseCompanion(page, 'Pip')

  await expect(page.getByLabel('Claude Code login command')).toHaveValue('claude /login')
  await expect(page.getByText('Sign in to an agent to continue.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
})

test('choosing a picture over the size limit should show an error', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await page.goto('/setup')
  const large = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])
  await page.getByLabel('Your own picture').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: large })
  await page.getByRole('button', { name: 'Use picture' }).click()

  await expect(page.getByRole('alert').filter({ hasText: 'picture' })).toHaveText('Choose a picture under 900 KB.')
  expect(existsSync(join(home, 'app-companion-image.png'))).toBe(false)
})

test('choosing a file that is not a picture should show an error', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await page.goto('/setup')
  const text = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  await page.getByLabel('Your own picture').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: text })
  await page.getByRole('button', { name: 'Use picture' }).click()

  await expect(page.getByRole('alert').filter({ hasText: 'picture' })).toHaveText('Choose a PNG, JPEG, WebP, or GIF picture.')
  expect(existsSync(join(home, 'app-companion-image.png'))).toBe(false)
})

test('removing the companion picture should delete its file', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await page.goto('/setup')
  await page.getByLabel('Your own picture').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG })
  await page.getByRole('button', { name: 'Use picture' }).click()
  await page.getByRole('button', { name: 'Remove picture' }).click()

  await expect(page.getByRole('button', { name: 'Remove picture' })).toBeHidden()
  expect(existsSync(join(home, 'app-companion-image.png'))).toBe(false)
  expect(readSettings(home).companionImage).toBeNull()
})

test('choosing a default agent should save it', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in', codex: 'signed-in' }))

  await page.goto('/setup')
  await chooseCompanion(page, 'Dash')
  await page.getByRole('radio', { name: 'Use Codex by default' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Add skills' })).toBeVisible()
  expect(readSettings(home).defaultProvider).toBe('codex')
})

test('choosing folders in the desktop picker should add them as projects', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const picked = [trackRepository(createGitRepository('api')), trackRepository(createGitRepository('web'))]
  // Stands in for electron/preload.ts: the native dialog returns these folders.
  await page.addInitScript((paths) => {
    Object.assign(window, { busyboyDesktop: { pickFolders: async () => paths, pathForFile: () => '' } })
  }, picked)

  await goToStart(page)
  await page.getByRole('button', { name: 'Choose folders…' }).click()

  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects.getByRole('listitem')).toHaveText([/api/, /web/])
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeEnabled()
})

test('dropping folders should add them as projects', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const repository = trackRepository(createGitRepository('mobile'))
  const plain = track(createTempFolder('plain'))
  // Stands in for electron/preload.ts: Electron reports a dropped folder's path.
  await page.addInitScript((paths) => {
    Object.assign(window, {
      busyboyDesktop: { pickFolders: async () => [], pathForFile: (file: File) => paths[file.name] ?? '' },
    })
  }, { mobile: repository, plain } as Record<string, string>)

  await goToStart(page)
  const dropZone = page.getByText('Drop project folders here')
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([], 'mobile'))
    transfer.items.add(new File([], 'plain'))
    return transfer
  })
  await dropZone.dispatchEvent('dragover', { dataTransfer })
  await dropZone.dispatchEvent('drop', { dataTransfer })

  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('mobile')
  await expect(page.getByRole('alert').filter({ hasText: plain })).toHaveText(
    `${plain} is not a git repository. Run git init there, or choose another folder.`,
  )
})

test('adding a folder that is not a git repository should show an error', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const folder = track(createTempFolder('plain'))

  await goToStart(page)
  await typeFolder(page, folder)

  await expect(page.getByRole('alert').filter({ hasText: folder })).toHaveText(
    `${folder} is not a git repository. Run git init there, or choose another folder.`,
  )
  await expect(page.getByText('No projects yet.')).toBeVisible()
})

test('removing a project should keep its folder', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const repository = trackRepository(createGitRepository('web'))

  await goToStart(page)
  await typeFolder(page, repository)
  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects).toContainText('web')

  await projects.getByRole('button', { name: 'Remove web' }).click()

  await expect(page.getByText('No projects yet.')).toBeVisible()
  expect(existsSync(join(repository, '.git'))).toBe(true)
  expect(existsSync(join(repository, 'README.md'))).toBe(true)
})

test('adding a folder named @scope should add the project', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const repository = trackRepository(createGitRepository('@scope'))

  await goToStart(page)
  await typeFolder(page, repository)

  const projects = page.getByRole('list', { name: 'Projects' })
  await expect(projects.getByText('scope', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'project name' })).toBeHidden()
})
