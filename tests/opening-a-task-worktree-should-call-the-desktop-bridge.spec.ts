import { realpathSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

test.skip(process.platform === 'win32', 'The terminal journey needs a POSIX shell.')

type WorktreeCall = { action: 'editor' | 'reveal'; path: string }

async function fakeDesktop(page: Page) {
  await page.addInitScript(() => {
    const calls: WorktreeCall[] = []
    Object.assign(window, {
      fakeWorktree: calls,
      busyboyDesktop: {
        pickFolders: async () => [],
        pathForFile: () => '',
        onFocus: () => () => {},
        readyUpdate: async () => null,
        onUpdateReady: () => () => {},
        installUpdate: async () => {},
        openInEditor: async (path: string) => {
          calls.push({ action: 'editor', path })
        },
        revealInFolder: async (path: string) => {
          calls.push({ action: 'reveal', path })
        },
      },
    })
  })
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { fakeWorktree: WorktreeCall[] }).fakeWorktree)

test('opening a task worktree should call the desktop bridge', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['api'])
  const worktree = realpathSync(addRecordTask(home, { project: 'api', projectPath: projects.api, id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }).worktree)
  await fakeDesktop(page)
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Projects' }).click()
  await sidebar.getByRole('region', { name: 'Project graph' }).getByRole('group', { name: 'Task Add a health endpoint' }).click()

  await expect(async () => {
    if (await page.getByRole('region', { name: 'Bottom panel' }).isHidden()) await page.keyboard.press('ControlOrMeta+j')
    await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)

  await page.getByRole('button', { name: 'Open in editor' }).click()
  await page.getByRole('button', { name: 'Reveal in folder' }).click()
  await expect.poll(() => calls(page)).toEqual([
    { action: 'editor', path: worktree },
    { action: 'reveal', path: worktree },
  ])
  await page.screenshot({ path: '/opt/cursor/artifacts/worktree-actions.png' })
})

test('a browser without the desktop app should not offer to open the worktree', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['api'])
  addRecordTask(home, { project: 'api', projectPath: projects.api, id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' })
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Projects' }).click()
  await sidebar.getByRole('region', { name: 'Project graph' }).getByRole('group', { name: 'Task Add a health endpoint' }).click()
  await expect(async () => {
    if (await page.getByRole('region', { name: 'Bottom panel' }).isHidden()) await page.keyboard.press('ControlOrMeta+j')
    await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await expect(page.getByLabel('Working directory')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in editor' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reveal in folder' })).toHaveCount(0)
})
