import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

test.skip(process.platform === 'win32', 'The terminal journeys need a POSIX shell.')

let worktree: string

test.beforeEach(() => {
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

  await page.getByRole('region', { name: 'Chat' }).click()
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeHidden()
})

test('pressing Ctrl+` in the terminal should close the panel', async ({ page }) => {
  await openTerminal(page)
  await page.keyboard.press('ControlOrMeta+Backquote')
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeHidden()
})

test('typing a command should show its output', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'echo "busyboy-$((6 * 7))"')
  await expect(terminal.locator('.xterm-rows')).toContainText('busyboy-42')
})

test('a shell should not see the server token, port, hostname, or Node environment', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, `printf 'busyboy-env token=%s port=%s host=%s node=%s end\\n' "$BUSYBOY_TOKEN" "$PORT" "$HOSTNAME" "$NODE_ENV"`)
  await expect(terminal.locator('.xterm-rows')).toContainText('busyboy-env token= port= host= node= end')
})

test('exiting the shell should offer a new terminal', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'exit 3')
  const status = page.getByRole('region', { name: 'Bottom panel' }).getByRole('status')
  await expect(status).toContainText('The shell exited with code 3.')

  await status.getByRole('button', { name: 'New terminal' }).click()
  await expect(status).toBeHidden()
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)
  await terminal.click()
  await run(page, 'echo "again-$((1 + 1))"')
  await expect(terminal.locator('.xterm-rows')).toContainText('again-2')
})


const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }
const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }

const ONE_TASK = 'In @web, add a CONTRIBUTING.md that explains how to run the project.'
const TWO_TASKS = 'Add a /health endpoint to @api and show its status in the footer of @web.'

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('selecting another task should keep the open shell and offer a new terminal there', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await openChat(page)
  await send(page, TWO_TASKS)
  const api = page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Select api · Add /health endpoint' })
  const web = page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Select web · Show API health in footer' })
  await expect(api).toBeVisible()
  await expect(web).toBeVisible()
  const tasks = (JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { project: string; worktree: string }[] }).tasks
  const health = realpathSync(tasks.find((task) => task.project === 'api')!.worktree)
  const footer = realpathSync(tasks.find((task) => task.project === 'web')!.worktree)

  await api.click()
  const terminal = await pressOpen(page)
  await expect(page.getByLabel('Working directory')).toHaveText(health)
  await terminal.click()
  await run(page, 'KEPT=yes')

  await web.click()

  const panel = page.getByRole('region', { name: 'Bottom panel' })
  await expect(page.getByLabel('Task', { exact: true })).toHaveText('api · Add /health endpoint')
  await terminal.click()
  await run(page, 'echo "kept-$KEPT"')
  await expect(terminal.locator('.xterm-rows')).toContainText('kept-yes')

  await panel.getByRole('button', { name: 'New terminal' }).click()
  await expect(page.getByLabel('Task', { exact: true })).toHaveText('web · Show API health in footer')
  await expect(page.getByLabel('Working directory')).toHaveText(footer)
  await expect(panel.getByRole('button', { name: 'New terminal' })).toBeHidden()
})

test('pressing the selected task again should open the next terminal in the home folder', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  await send(page, ONE_TASK)
  const toggle = page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Select web · Add CONTRIBUTING.md' })
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await pressOpen(page)
  await expect(page.getByLabel('Working directory')).toHaveText(homedir())
  await expect(page.getByLabel('Task', { exact: true })).toHaveCount(0)
})

test('selecting a task in the chat should open the terminal in its worktree', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
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
  const file = join(home, 'task-list.json')
  const task = { id: HEALTH.id, project: 'api', title: HEALTH.title, worktree: elsewhere }
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [task] }))
  const start = async () => {
    const response = await context.request.post('/api/terminal', { data: { taskId: HEALTH.id } })
    return { status: response.status(), error: ((await response.json()) as { error: string }).error }
  }
  const refused = { status: 400, error: `The worktree of "${HEALTH.title}" is not one of BusyBoy's task worktrees.` }

  expect(await start()).toEqual(refused)

  await addRecordTask(home, { project: 'api', projectPath: projects.api, ...FOOTER })
  expect(await start()).toEqual(refused)

  const link = join(home, 'task-worktrees', 'api', HEALTH.id)
  symlinkSync(elsewhere, link)
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ ...task, worktree: link }] }))
  expect(await start()).toEqual(refused)

  const unknown = await context.request.post('/api/terminal', { data: { taskId: 'no-such-task' } })
  expect(unknown.status()).toBe(400)
  expect(((await unknown.json()) as { error: string }).error).toBe('That task no longer exists.')
})
