import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
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

// ---- The selected task's worktree ----------------------------------------------

const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }
const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }

/** Two tasks with worktrees, as busyboy stores them (tests/fixtures/records/). */
async function useTaskHome(context: BrowserContext, baseURL: string) {
  const { home, projects } = await useProjectsHome(context, baseURL, ['web', 'api'])
  const health = addRecordTask(home, { project: 'api', projectPath: projects.api, ...HEALTH })
  const footer = addRecordTask(home, { project: 'web', projectPath: projects.web, ...FOOTER })
  // The shell starts in the resolved folder (the temp folder is behind a symlink on macOS).
  return { home, health: realpathSync(health.worktree), footer: realpathSync(footer.worktree) }
}

async function openGraph(page: Page) {
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Projects' }).click()
  return sidebar.getByRole('region', { name: 'Project graph' })
}

test('selecting a task then opening the terminal should start in its worktree', async ({ page, context, baseURL }) => {
  const { health } = await useTaskHome(context, baseURL!)
  const graph = await openGraph(page)
  const task = graph.getByRole('group', { name: `Task ${HEALTH.title}` })

  await task.click()
  await expect(task.getByRole('button', { pressed: true })).toBeVisible()
  const terminal = await pressOpen(page)

  await expect(page.getByLabel('Task', { exact: true })).toHaveText(`api · ${HEALTH.title}`)
  await expect(page.getByLabel('Working directory')).toHaveText(health)
  await terminal.click()
  await run(page, 'pwd')
  await expect(terminal.locator('.xterm-rows')).toContainText(`api/${HEALTH.id}`)
})

test('selecting another task should keep the open shell and offer a new terminal there', async ({ page, context, baseURL }) => {
  const { health, footer } = await useTaskHome(context, baseURL!)
  const graph = await openGraph(page)
  await graph.getByRole('group', { name: `Task ${HEALTH.title}` }).click()
  const terminal = await pressOpen(page)
  await expect(page.getByLabel('Working directory')).toHaveText(health)
  await terminal.click()
  await run(page, 'KEPT=yes')

  await graph.getByRole('group', { name: `Task ${FOOTER.title}` }).click()

  // The running shell stays where it is until the user asks for a new one.
  const panel = page.getByRole('region', { name: 'Bottom panel' })
  await expect(page.getByLabel('Task', { exact: true })).toHaveText(`api · ${HEALTH.title}`)
  await terminal.click()
  await run(page, 'echo "kept-$KEPT"')
  await expect(terminal.locator('.xterm-rows')).toContainText('kept-yes')

  await panel.getByRole('button', { name: 'New terminal' }).click()
  await expect(page.getByLabel('Task', { exact: true })).toHaveText(`web · ${FOOTER.title}`)
  await expect(page.getByLabel('Working directory')).toHaveText(footer)
  await expect(panel.getByRole('button', { name: 'New terminal' })).toBeHidden()
})

test('pressing the selected task again should open the next terminal in the home folder', async ({ page, context, baseURL }) => {
  await useTaskHome(context, baseURL!)
  const graph = await openGraph(page)
  const toggle = graph.getByRole('group', { name: `Task ${HEALTH.title}` }).getByRole('button')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // From the keyboard this time. The click's hover opens the details card after a delay; a key
  // pressed while it opened was sometimes lost (1 run in 5), so wait for it first.
  await expect(page.getByRole('group', { name: 'Task details' })).toBeVisible()
  await toggle.press('Enter')

  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await pressOpen(page)
  // The server and the test run as the same user with the same HOME.
  await expect(page.getByLabel('Working directory')).toHaveText(homedir())
  await expect(page.getByLabel('Task', { exact: true })).toHaveCount(0)
})

test('selecting a task in the chat should open the terminal in its worktree', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  // The recorded Director script (tests/provider-scripts/director-one-task.json) creates one task in web.
  await page.getByRole('textbox', { name: 'Message' }).fill('In @web, add a CONTRIBUTING.md that explains how to run the project.')
  await page.getByRole('button', { name: 'Send' }).click()
  const select = page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Select web · Add CONTRIBUTING.md' })

  await select.click()

  await expect(select).toHaveAttribute('aria-pressed', 'true')
  await pressOpen(page)
  const [task] = (JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { worktree: string }[] }).tasks
  await expect(page.getByLabel('Task', { exact: true })).toHaveText('web · Add CONTRIBUTING.md')
  await expect(page.getByLabel('Working directory')).toHaveText(realpathSync(task.worktree))
})

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
