import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

// The journeys type POSIX shell commands into the pinned test shell (/bin/sh).
test.skip(process.platform === 'win32', 'The terminal journeys need a POSIX shell.')

let worktree: string

test.beforeEach(() => {
  // A folder of its own, passed with ?cwd= (honored only in test mode).
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'busyboy-terminal-')))
})

test.afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

async function openTerminal(page: Page) {
  await page.goto(`/?cwd=${encodeURIComponent(worktree)}`)
  const terminal = await pressOpen(page)
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)
  return terminal
}

/** Opens the bottom panel on the page as it is and waits for the terminal. */
async function pressOpen(page: Page) {
  const panel = page.getByRole('region', { name: 'Bottom panel' })
  await expect(panel).toBeHidden()
  // A key pressed before hydration is dropped, so press again only while the
  // panel is still closed; a press that landed is never undone.
  await expect(async () => {
    if (await panel.isHidden()) await page.keyboard.press('ControlOrMeta+j')
    await expect(panel).toBeVisible({ timeout: 1_000 })
  }).toPass()
  const terminal = page.getByRole('region', { name: 'Terminal' })
  await expect(terminal).toBeVisible()
  return terminal
}

async function run(page: Page, command: string) {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test('pressing Cmd+J should open a terminal in the task worktree', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'pwd')
  await expect(terminal.locator('.xterm-rows')).toContainText(worktree)

  // Outside the terminal the shortcut closes the panel again.
  await page.getByRole('region', { name: 'Chat' }).click()
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeHidden()
})

test('pressing Ctrl+` in the terminal should close the panel', async ({ page }) => {
  await openTerminal(page)
  // Off macOS Ctrl+J belongs to the shell here, so Ctrl+` (Cmd+` on macOS) is the way out.
  await page.keyboard.press('ControlOrMeta+Backquote')
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeHidden()
})

test('typing a command should show its output', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'echo "busyboy-$((6 * 7))"')
  await expect(terminal.locator('.xterm-rows')).toContainText('busyboy-42')
})

test('exiting the shell should offer a new terminal', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'exit 3')
  // Scoped to the panel: the chat's message box has a status region of its own.
  const status = page.getByRole('region', { name: 'Bottom panel' }).getByRole('status')
  await expect(status).toContainText('The shell exited with code 3.')

  await status.getByRole('button', { name: 'New terminal' }).click()
  await expect(status).toBeHidden()
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)
  await terminal.click()
  await run(page, 'echo "again-$((1 + 1))"')
  await expect(terminal.locator('.xterm-rows')).toContainText('again-2')
})

// ---- Task worktrees -----------------------------------------------------------

const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }
const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }

test('starting a terminal in a folder that is not a task worktree should be refused', async ({ context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['api'])
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(elsewhere)
  // A task list edited to point a task at another folder, before any task worktree exists.
  const file = join(home, 'task-list.json')
  const task = { id: HEALTH.id, project: 'api', title: HEALTH.title, worktree: elsewhere }
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [task] }))
  const start = async () => {
    const response = await context.request.post('/api/terminal', { data: { taskId: HEALTH.id } })
    return { status: response.status(), error: ((await response.json()) as { error: string }).error }
  }
  const refused = { status: 400, error: `The worktree of "${HEALTH.title}" is not one of BusyBoy's task worktrees.` }

  expect(await start()).toEqual(refused)

  // A folder elsewhere, with real task worktrees next to it.
  addRecordTask(home, { project: 'api', projectPath: projects.api, ...FOOTER })
  expect(await start()).toEqual(refused)

  // A link in the task's own place that leads out of the worktrees folder.
  const link = join(home, 'task-worktrees', 'api', HEALTH.id)
  symlinkSync(elsewhere, link)
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ ...task, worktree: link }] }))
  expect(await start()).toEqual(refused)

  const unknown = await context.request.post('/api/terminal', { data: { taskId: 'no-such-task' } })
  expect(unknown.status()).toBe(400)
  expect(((await unknown.json()) as { error: string }).error).toBe('That task no longer exists.')
})
