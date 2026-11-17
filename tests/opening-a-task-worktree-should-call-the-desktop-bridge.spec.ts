import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

test.skip(process.platform === 'win32', 'The terminal journey needs a POSIX shell.')

const REQUEST = 'In @web, add a CONTRIBUTING.md that explains how to run the project.'

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

async function selectTask(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await page.getByRole('textbox', { name: 'Message' }).fill(REQUEST)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Select web · Add CONTRIBUTING.md' }).click()
  await page.getByRole('button', { name: 'Toggle bottom panel' }).click()
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeVisible()
}

test('opening a task worktree should call the desktop bridge', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await fakeDesktop(page)
  await selectTask(page)
  const [task] = (JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { worktree: string }[] }).tasks
  const worktree = realpathSync(task.worktree)
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)

  await page.getByRole('button', { name: 'Open in editor' }).click()
  await page.getByRole('button', { name: 'Reveal in folder' }).click()
  await expect.poll(() => calls(page)).toEqual([
    { action: 'editor', path: worktree },
    { action: 'reveal', path: worktree },
  ])
})

test('a browser without the desktop app should not offer to open the worktree', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await selectTask(page)
  await expect(page.getByLabel('Working directory')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in editor' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reveal in folder' })).toHaveCount(0)
})
