import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const FORCE_PUSH_REQUEST = 'Force push the branch to origin.'
const RELEASE_REQUEST = 'Run the release script.'
const CLEAN_REQUEST = 'Remove the build folder.'
const DIRECTOR_PUSH_REQUEST = 'Force push the main branch yourself.'
const ARTIFACT_REQUEST = 'Download the CI screenshots into the task record.'
const OUTSIDE_REQUEST = 'Delete a folder that is outside this task.'
const OUTSIDE_VARIABLE_REQUEST = 'Delete a folder named by a variable that points outside this task.'
const SCRATCH_REQUEST = 'Save a screenshot in the scratch folder and then remove it.'

const expect = baseExpect.configure({ timeout: 15_000 })

let home: string

async function createTask(request: APIRequestContext, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0].text).toBe(false)
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

// Hydrating the controlled textarea sets its value again, which drops anything filled before then.
async function openApprovals(page: Page) {
  await page.goto('/setup?step=approvals')
  const list = page.getByRole('textbox', { name: 'Always-ask list' })
  await expect.poll(() => list.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps$')))).toBe(true)
  return list
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })
const openCards = (page: Page) =>
  transcript(page).getByRole('group', { name: /^(Question|Approval|Plan|Progress|Done|Pull requests) from / })
const taskRow = (page: Page, title: string) => transcript(page).getByLabel(`web · ${title}`, { exact: true })

test.describe('Claude task agents', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
  })

  test('a force push by a task agent should ask with an approval card, and denying it should stop the push', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

    const card = openCard(page, 'Approval from web · Force push')
    await expect(card).toContainText('Bash: git push --force origin HEAD')
    await expect(card).toContainText('On your always-ask list: Force push or delete a remote branch')
    await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BAlways allow this exact command', 'CDeny'])
    await card.getByRole('button', { name: 'C. Deny' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Force push' })).toContainText('C · Deny')
    await expect(taskRow(page, 'Force push')).toContainText('Idle')
  })

  test('always allowing a force push should run that exact command again without a card, but ask for another branch', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

    const card = openCard(page, 'Approval from web · Force push')
    await expect(card).toContainText('Bash: git push --force origin HEAD')
    await card.getByRole('button', { name: 'B. Always allow this exact command' }).click()

    await expect(card).toContainText('Bash: git push --force origin release')
    await card.getByRole('button', { name: 'C. Deny' }).click()
    await expect(openCards(page)).toHaveCount(0)
    await expect(taskRow(page, 'Force push')).toContainText('Idle')
  })

  test('a force push by the Director should be refused, never run', async ({ page }) => {
    await openChat(page)
    await page.getByRole('textbox', { name: 'Message' }).fill(DIRECTOR_PUSH_REQUEST)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Reply' })).toHaveText('I could not run that, so a task will have to do it.')
    await expect(openCards(page)).toHaveCount(0)
  })

  test("the Director changing BusyBoy's task list or reading its settings with a command should be refused", async ({ page }) => {
    await openChat(page)
    const reply = transcript(page).getByRole('group', { name: 'Reply' })
    await page.getByRole('textbox', { name: 'Message' }).fill('Clear the task list file yourself.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(reply).toHaveText('BusyBoy kept me out of its task list.')

    await page.getByRole('textbox', { name: 'Message' }).fill('Show the settings file with a command.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(reply.last()).toHaveText('BusyBoy kept me out of its settings.')
    await expect(openCards(page)).toHaveCount(0)
  })

  test('the Director writing in its own folder should run without asking', async ({ page }) => {
    await openChat(page)
    await page.getByRole('textbox', { name: 'Message' }).fill('Keep a note in your own folder.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(transcript(page).getByRole('group', { name: 'Reply' })).toHaveText('Saved the note.')
  })

  test('deleting a file outside the task with an apply_patch heredoc should ask', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Delete notes', 'Delete the notes file outside this task with a patch.')

    const card = openCard(page, 'Approval from web · Delete notes')
    await expect(card).toContainText('On your always-ask list: Delete outside the task folder')
    await card.getByRole('button', { name: 'C. Deny' }).click()
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Delete notes' })).toContainText('C · Deny')
    await expect(taskRow(page, 'Delete notes')).toContainText('Idle')
  })

  test('updating a file whose diff mentions a force push should not ask', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Update footer', 'Update the footer, and mention the force push in the diff.')

    await expect(taskRow(page, 'Update footer')).toContainText('Idle')
    await expect(openCards(page)).toHaveCount(0)
  })

  test('a force push sent as shell_command with cmd should ask', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Shell push', 'Force push using the shell_command tool.')

    const card = openCard(page, 'Approval from web · Shell push')
    await expect(card).toContainText('shell_command: git push --force origin HEAD')
    await expect(card).toContainText('On your always-ask list: Force push or delete a remote branch')
    await card.getByRole('button', { name: 'C. Deny' }).click()
    await expect(taskRow(page, 'Shell push')).toContainText('Idle')
  })

  test('a force push passed as one command-line argument should ask', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Argv push', 'Force push, with the command passed as one argument.')

    const card = openCard(page, 'Approval from web · Argv push')
    await expect(card).toContainText('Bash: git push --force origin feature')
    await card.getByRole('button', { name: 'C. Deny' }).click()
    await expect(taskRow(page, 'Argv push')).toContainText('Idle')
  })

  test('a delete inside the task folder should run without a card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Clean build', CLEAN_REQUEST)

    await expect(taskRow(page, 'Clean build')).toContainText('Idle')
    await expect(openCards(page)).toHaveCount(0)
  })

  test('downloading a CI artifact into the record folder should run without a card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'CI screenshots', ARTIFACT_REQUEST)

    await expect(taskRow(page, 'CI screenshots')).toContainText('Idle')
    await expect(openCards(page)).toHaveCount(0)
  })

  test('deleting outside the worktree and the record folder should ask', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Delete outside', OUTSIDE_REQUEST)

    const card = openCard(page, 'Approval from web · Delete outside')
    await expect(card).toContainText('On your always-ask list: Delete outside the task folder')
    await card.getByRole('button', { name: 'C. Deny' }).click()
    await expect(taskRow(page, 'Delete outside')).toContainText('Idle')
  })

  test('a variable that resolves outside the task folders should ask', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Delete variable', OUTSIDE_VARIABLE_REQUEST)

    const card = openCard(page, 'Approval from web · Delete variable')
    await expect(card).toContainText('Bash: A=/tmp/busyboy-outside-task; rm -rf $A')
    await expect(card).toContainText('On your always-ask list: Delete outside the task folder')
    await card.getByRole('button', { name: 'C. Deny' }).click()
    await expect(taskRow(page, 'Delete variable')).toContainText('Idle')
  })

  test('writing and deleting in the scratch folder should run without a card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Scratch files', SCRATCH_REQUEST)

    await expect(taskRow(page, 'Scratch files')).toContainText('Idle')
    await expect(openCards(page)).toHaveCount(0)

    const { tasks } = JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { title: string; worktree: string }[] }
    const worktree = tasks.find((task) => task.title === 'Scratch files')?.worktree
    if (!worktree) throw new Error('The scratch task has no worktree.')
    expect(existsSync(join(worktree, '.busyboy-scratch'))).toBe(true)
    const instructions = readFileSync(join(worktree, 'task-instructions.txt'), 'utf8')
    expect(instructions).toContain('.busyboy-scratch')
    expect(instructions).toContain('Do not put them in the record folder or elsewhere in the worktree.')
    const ignored = execFileSync('git', ['-C', worktree, 'check-ignore', '-v', '--', '.busyboy-scratch/shot.png'], { encoding: 'utf8' })
    expect(ignored).toContain('info/exclude')
    expect(ignored).toContain('.busyboy-scratch/')
    expect(execFileSync('git', ['-C', worktree, 'status', '--porcelain', '--', '.gitignore'], { encoding: 'utf8' })).toBe('')
  })

  test('adding a rule in Setup should make task agents ask before that action', async ({ page, context }) => {
    const list = await openApprovals(page)
    await expect(list).toHaveValue(/^Force push or delete a remote branch\n/)
    await list.fill(`${await list.inputValue()}\nBash(./release.sh*)`)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('heading', { name: 'Add projects' })).toBeVisible()
    const saved = JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')) as { alwaysAsk: string[] }
    expect(saved.alwaysAsk.at(-1)).toBe('Bash(./release.sh*)')

    await openChat(page)
    await createTask(context.request, 'Release', RELEASE_REQUEST)
    const card = openCard(page, 'Approval from web · Release')
    await expect(card).toContainText('On your always-ask list: Bash(./release.sh*)')
    await card.getByRole('button', { name: 'A. Allow' }).click()
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Release' })).toContainText('A · Allow')
  })

  test('saving a bare command as a rule in Setup should be refused', async ({ page }) => {
    const list = await openApprovals(page)
    await list.fill(`${await list.inputValue()}\n./release.sh`)
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText('"./release.sh" is not a tool name. Write a command as Bash(./release.sh).')).toBeVisible()
    await expect(list).toHaveValue(/\n\.\/release\.sh$/)
    expect((JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')) as { alwaysAsk?: unknown }).alwaysAsk ?? null).toBeNull()
  })

  test('clicking Restore defaults should bring back the default always-ask list', async ({ page }) => {
    const list = await openApprovals(page)
    await list.fill('Bash(./release.sh*)')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('heading', { name: 'Add projects' })).toBeVisible()

    await openApprovals(page)
    await expect(list).toHaveValue('Bash(./release.sh*)')
    await page.getByRole('button', { name: 'Restore defaults' }).click()

    await expect(list).toHaveValue(/Delete outside the task folder/)
    expect((JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')) as { alwaysAsk: unknown }).alwaysAsk).toBeNull()
  })
})

test.describe('Codex task agents', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    ;({ home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out' }))
  })

  test("a force push by a Codex task agent should ask through BusyBoy's hook", async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

    const card = openCard(page, 'Approval from web · Force push')
    await expect(card).toContainText('Bash: git push --force origin HEAD')
    await card.getByRole('button', { name: 'A. Allow' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Force push' })).toContainText('A · Allow')
    await expect(taskRow(page, 'Force push')).toContainText('Idle')
  })
})
