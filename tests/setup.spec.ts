import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createGitRepository, createTempFolder, removeFolder, useTestHome } from './support/test-home'

// Recorded in tests/provider-scripts/claude-plain-reply.json.
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'

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

/** Skips the always-ask step with the list as it is. */
async function skipApprovals(page: Page) {
  await expect(page.getByRole('heading', { name: 'Always ask before' })).toBeVisible()
  await page.getByRole('link', { name: 'Skip' }).click()
}

/** From the companion step to the start step, skipping skills and approvals. */
async function goToStart(page: Page, companion = 'Nori') {
  await page.goto('/setup')
  await chooseCompanion(page, companion)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('link', { name: 'Skip' }).click()
  await skipApprovals(page)
  await expect(page.getByRole('heading', { name: 'Add projects' })).toBeVisible()
}

async function typeFolder(page: Page, folder: string) {
  await page.getByLabel('Folder path').fill(folder)
  await page.getByRole('button', { name: 'Add folder' }).click()
}

test('finishing setup should open the main screen', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in', codex: 'signed-out' }))
  const repository = trackRepository(createGitRepository('shop'))

  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole('navigation', { name: 'Setup steps' }).getByRole('link', { name: '1 Companion' })).toHaveAttribute(
    'aria-current',
    'step',
  )
  await chooseCompanion(page, 'Nori')

  const agents = page.getByRole('list', { name: 'Agents' })
  await expect(agents.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('Signed in')
  await expect(agents.getByRole('listitem').filter({ hasText: 'Codex' })).toContainText('Signed out')
  await expect(page.getByLabel('Codex login command')).toHaveValue('codex login')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Add skills' })).toBeVisible()
  await page.getByRole('link', { name: 'Continue' }).click()
  await skipApprovals(page)

  await typeFolder(page, repository)
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('shop')
  await page.screenshot({ path: test.info().outputPath('setup.png'), fullPage: true })
  await page.getByRole('button', { name: 'Start chatting' }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()
})

test("choosing a companion should carry it into the Director's greeting", async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await page.goto('/setup')
  await chooseCompanion(page, 'Sage')
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('radio', { name: /^Sage the owl/ })).toBeChecked()

  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('link', { name: 'Skip' }).click()
  await skipApprovals(page)
  await page.getByRole('button', { name: 'Start without a project' }).click()

  const chat = page.getByRole('region', { name: 'Chat' })
  await expect(chat.getByText('Sage, your director', { exact: true })).toBeVisible()
  await expect(chat.getByText("Sage here. Tell me what you're building, and we'll think it through together.")).toBeVisible()
  expect(readSettings(home).companion).toBe('sage')
})

test('starting without a project should open the chat', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await goToStart(page)
  await expect(page.getByText('No projects yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Start without a project' }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('textbox', { name: 'Message' }).fill(PLAIN_PROMPT)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('log', { name: 'Transcript' }).getByText('Hello from busyboy.', { exact: true })).toBeVisible()
  expect(readSettings(home).projects).toEqual([])
})

test('continuing without a signed-in agent should not be possible', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-out', codex: 'signed-out' }))

  await page.goto('/setup')
  await chooseCompanion(page, 'Pip')

  await expect(page.getByLabel('Claude Code login command')).toHaveValue('claude /login')
  await expect(page.getByText('Sign in to an agent to continue.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
})

test('an outdated Claude Code should ask for an update before continuing', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'outdated', codex: 'signed-out' }))

  await page.goto('/setup')
  await chooseCompanion(page, 'Pip')

  const agents = page.getByRole('list', { name: 'Agents' })
  await expect(agents.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('Update needed')
  await expect(page.getByLabel('Claude Code update command')).toHaveValue('claude update')
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

test('setting a companion picture should show it in the greeting', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await page.goto('/setup')
  await page.getByRole('radio', { name: /^Mochi the penguin/ }).click()
  await page.getByLabel('Your own picture').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG })
  await page.getByRole('button', { name: 'Use picture' }).click()
  await expect(page.getByRole('button', { name: 'Remove picture' })).toBeVisible()
  expect(readFileSync(join(home, 'app-companion-image.png'))).toEqual(PNG)

  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('link', { name: 'Skip' }).click()
  await skipApprovals(page)
  await page.getByRole('button', { name: 'Start without a project' }).click()

  const chat = page.getByRole('region', { name: 'Chat' })
  await expect(chat.getByText('Mochi, your director', { exact: true })).toBeVisible()
  await expect(chat.locator('img[src^="/api/companion-image"]')).toBeVisible()
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

test('opening the app after setup should skip setup', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const repository = trackRepository(createGitRepository('api'))

  await goToStart(page)
  await typeFolder(page, repository)
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('api')
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()

  // Closed first, as quitting would. Each open main screen holds the app's event streams, and two
  // screens fill Chromium's six connections per host, which stalls the next navigation.
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/')
  await expect(reopened).toHaveURL(/\/$/)
  await expect(reopened.getByRole('region', { name: 'Chat' })).toBeVisible()

  await reopened.getByRole('link', { name: 'Setup' }).click()
  await expect(reopened).toHaveURL(/\/setup$/)
  await reopened.getByRole('link', { name: '5 Start' }).click()
  await expect(reopened.getByRole('list', { name: 'Projects' })).toContainText('api')
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

test('opening the app with a corrupt settings file should show setup again', async ({ page, context, baseURL }) => {
  const home = track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))
  const corrupt = '{"setupCompletedAt": "2026-11-14T00:00:00.000Z", "projects": ['
  writeFileSync(join(home, 'app-settings.json'), corrupt)

  await page.goto('/')

  await expect(page).toHaveURL(/\/setup$/)
  const moved = readdirSync(home).filter((name) => /^app-settings\.corrupt-.+\.json$/.test(name))
  expect(moved).toHaveLength(1)
  expect(readFileSync(join(home, moved[0]), 'utf8')).toBe(corrupt)

  await chooseCompanion(page, 'Pip')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('link', { name: 'Skip' }).click()
  await skipApprovals(page)
  await page.getByRole('button', { name: 'Start without a project' }).click()
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()
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

test('going back from setup after signing out should open the main screen', async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: 'signed-in' }))

  await goToStart(page)
  await page.getByRole('button', { name: 'Start without a project' }).click()
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()

  await context.addCookies([
    { name: 'busyboy-test-sign-in', value: 'claude=signed-out,codex=signed-out', url: baseURL! },
  ])
  await page.getByRole('link', { name: 'Setup' }).click()
  await page.getByRole('link', { name: '2 Agents' }).click()
  const agents = page.getByRole('list', { name: 'Agents' })
  await expect(agents.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('Signed out')

  await page.getByRole('link', { name: 'Back to chat' }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()
})
