import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Task agents that wait on the user, played from tests/provider-scripts/task-cards.json
// (Claude) and tests/provider-scripts/codex/approval.json (the real Codex adapter).
const PLAN_REQUEST = 'Add a footer with the project name to the web app.'
const QUESTION_REQUEST = 'Add a license file to the project.'
const APPROVAL_REQUEST = 'Clean up the old build output.'
const TWIN_QUESTIONS_REQUEST = 'Pick the two theme colors.'
const CODEX_APPROVAL_REQUEST = 'Run the shell command `touch notes.txt`, then reply with exactly: Created notes.txt.'

// A Codex task starts the fake app server, a Node process, which can be slow on a busy machine.
const expect = baseExpect.configure({ timeout: 15_000 })

/** Creates a task the way the Director does, through busyboy's MCP tool. */
async function createTask(request: APIRequestContext, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false).toBe(false)
  const { tasks } = JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { title: string; worktree: string; id: string }[] }
  return tasks.find((task) => task.title === title)!
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

const pinned = (page: Page) => page.getByRole('region', { name: 'Waiting for you' })
const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })

let home: string

test.describe('Claude task agents', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
  })

  test('clicking a lettered option on a question card should answer the task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Add a license', QUESTION_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Question from web · Add a license' })
    await expect(card).toContainText('License: Which license should the project use?')
    await expect(card.getByRole('button', { name: 'A. MIT (Recommended)' })).toContainText('Recommended')
    await expect(card.getByRole('button', { name: 'B. Apache-2.0' })).toBeVisible()
    await expect(transcript(page).getByLabel('web · Add a license', { exact: true })).toContainText('Needs you')

    // Unanswered cards stay pinned, also after the page loads again.
    await page.reload()
    await card.getByRole('button', { name: 'A. MIT (Recommended)' }).click()

    await expect(pinned(page)).toHaveCount(0)
    const record = transcript(page).getByRole('group', { name: 'Card from web · Add a license' })
    await expect(record).toContainText('Which license should the project use?')
    await expect(record).toContainText('A · MIT')
    await expect(transcript(page).getByLabel('web · Add a license', { exact: true })).toContainText('Idle')
  })

  test('clicking Allow for this session on an approval card should let the task agent continue', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Clean up dist', APPROVAL_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Approval from web · Clean up dist' })
    await expect(card).toContainText('Bash: rm -rf dist')
    // A reply to an approval denies it, so the composer stays with the Director until the user picks Reply.
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', 'Message BusyBoy')
    await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BAllow for this session', 'CDeny'])
    await card.getByRole('button', { name: 'B. Allow for this session' }).click()

    await expect(pinned(page)).toHaveCount(0)
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Clean up dist' })).toContainText('B · Allow for this session')
    await expect(transcript(page).getByLabel('web · Clean up dist', { exact: true })).toContainText('Idle')
  })

  test('clicking Approve on an Align card should start the task', async ({ page, context }) => {
    await openChat(page)
    const task = await createTask(context.request, 'Add a footer', PLAN_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Plan from web · Add a footer' })
    await expect(card).toContainText(
      'Every page of the web app ends with a footer that shows the project name. The footer sits below the main content and uses the app\'s muted text color. When done: a footer with the project name on every page.',
    )
    // The agent is idle between turns, but the task waits on the user.
    await expect(transcript(page).getByLabel('web · Add a footer', { exact: true })).toContainText('Needs you')
    await card.getByRole('button', { name: 'View details' }).click()
    const details = page.getByRole('dialog', { name: 'Plan: Add a site footer' })
    await expect(details.getByRole('heading', { name: 'Footer component' })).toBeVisible()
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'Approve' }).click()

    await expect(pinned(page)).toHaveCount(0)
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Add a footer' })).toContainText('Approved')
    // The agent got the approval and saved the plan as approved.
    await expect.poll(() => readFileSync(join(task.worktree, '.jwn', task.id, 'ALIGN.md'), 'utf8')).toContain('Status: approved')
    // Its turn ended with the approved plan, which asks for nothing more.
    await expect(transcript(page).getByLabel('web · Add a footer', { exact: true })).toContainText('Idle')
    await expect(pinned(page)).toHaveCount(0)
  })

  test('clicking Reply on an Align card and sending should send the change to its task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Add a footer', PLAN_REQUEST)
    const card = pinned(page).getByRole('group', { name: 'Plan from web · Add a footer' })
    await expect(card).toBeVisible()

    const composer = page.getByRole('textbox', { name: 'Message' })
    // The card does not take the composer; the user picks it.
    await expect(composer).toHaveAttribute('aria-placeholder', 'Message BusyBoy')
    await card.getByRole('button', { name: 'Reply' }).click()
    await expect(composer).toHaveAttribute('aria-placeholder', 'Reply to web · Add a footer')
    await composer.fill('Also show the current year.')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Your reply to web · Add a footer' })).toHaveText('Also show the current year.')
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Add a footer' })).toContainText('Changes requested')
    // The closed card comes first, then the reply that closed it.
    await expect(transcript(page).getByRole('group', { name: /^(Card from|Your reply to) web · Add a footer$/ }).first()).toHaveAccessibleName(
      'Card from web · Add a footer',
    )
    // The agent revised its draft, so a new plan card asks again.
    await expect(pinned(page).getByRole('group', { name: 'Plan from web · Add a footer' })).toContainText(
      'When done: a footer with the project name on every page and the current year.',
    )
    // Nothing went to the Director, and the reply target ended with the card it answered.
    await expect(transcript(page).getByLabel('Your message')).toHaveCount(0)
    await expect(composer).toHaveAttribute('aria-placeholder', 'Message BusyBoy')

    // The next message goes to the Director as usual.
    await composer.fill('What is running right now?')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(transcript(page).getByLabel('Your message')).toHaveText('What is running right now?')
  })

  test('a card closing before a reply is sent should not send the reply to the Director', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Add a footer', PLAN_REQUEST)
    const card = pinned(page).getByRole('group', { name: 'Plan from web · Add a footer' })
    await card.getByRole('button', { name: 'Reply' }).click()
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill('Yes, go ahead.')

    await transcript(page).getByRole('button', { name: 'Stop web · Add a footer' }).click()
    await expect(pinned(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByRole('alert').filter({ hasText: 'The card you were replying to closed' })).toContainText('Send again to message BusyBoy.')
    await expect(composer).toHaveText('Yes, go ahead.')
    await expect(transcript(page).getByLabel('Your message')).toHaveCount(0)
  })

  test('a card opening while the user types should leave the composer with the Director', async ({ page, context }) => {
    await openChat(page)
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill('What is running right now?')

    await createTask(context.request, 'Add a license', QUESTION_REQUEST)
    await expect(pinned(page).getByRole('group', { name: 'Question from web · Add a license' })).toBeVisible()

    await expect(composer).toHaveText('What is running right now?')
    await expect(page.getByText(/^Replying to /)).toHaveCount(0)
    await composer.fill('')
    await expect(composer).toHaveAttribute('aria-placeholder', 'Message BusyBoy')
  })

  test('answering two questions that share their text should keep both answers', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Pick colors', TWIN_QUESTIONS_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Question from web · Pick colors' })
    const [first, second] = [card.getByRole('group').nth(0), card.getByRole('group').nth(1)]
    await first.getByRole('button', { name: 'A. Red' }).click()
    await second.getByRole('button', { name: 'B. Blue' }).click()
    await expect(first.getByRole('button', { name: 'A. Red' })).toHaveAttribute('aria-pressed', 'true')
    await expect(second.getByRole('button', { name: 'A. Red' })).toHaveAttribute('aria-pressed', 'false')
    await card.getByRole('button', { name: 'Answer' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Pick colors' })).toContainText('A · Red; B · Blue')
    await expect(transcript(page).getByLabel('web · Pick colors', { exact: true })).toContainText('Idle')
  })

  test('clicking Stop task on a card should stop its task', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Clean up dist', APPROVAL_REQUEST)

    await pinned(page).getByRole('group', { name: 'Approval from web · Clean up dist' }).getByRole('button', { name: 'Stop task' }).click()

    await expect(pinned(page)).toHaveCount(0)
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Clean up dist' })).toContainText('Stopped')
    await expect(transcript(page).getByLabel('web · Clean up dist', { exact: true })).toContainText('Stopped')
  })

  test('clicking Stop in the task group should stop the task and close its card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Add a footer', PLAN_REQUEST)
    await expect(pinned(page).getByRole('group', { name: 'Plan from web · Add a footer' })).toBeVisible()

    await transcript(page).getByRole('button', { name: 'Stop web · Add a footer' }).click()

    await expect(transcript(page).getByLabel('web · Add a footer', { exact: true })).toContainText('Stopped')
    await expect(pinned(page)).toHaveCount(0)
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Add a footer' })).toContainText('Stopped')
  })
})

test.describe('Codex task agents', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    // Only Codex is signed in, so the task agent runs on the real Codex adapter.
    ;({ home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out' }))
  })

  test('clicking Allow on a Codex task agent approval card should let it continue', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Create notes', CODEX_APPROVAL_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Approval from web · Create notes' })
    await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BDeny'])
    await card.getByRole('button', { name: 'A. Allow' }).click()

    await expect(pinned(page)).toHaveCount(0)
    await expect(transcript(page).getByRole('group', { name: 'Card from web · Create notes' })).toContainText('A · Allow')
    await expect(transcript(page).getByLabel('web · Create notes', { exact: true })).toContainText('Idle')
  })
})
