import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Task agents that run actions on the always-ask list, played from
// tests/provider-scripts/always-ask.json (Claude) and, through the real Codex
// adapter and its hook, tests/provider-scripts/codex/always-ask.json.
const FORCE_PUSH_REQUEST = 'Force push the branch to origin.'
const RELEASE_REQUEST = 'Run the release script.'
const CLEAN_REQUEST = 'Remove the build folder.'
const DIRECTOR_PUSH_REQUEST = 'Force push the main branch yourself.'

// A Codex task starts the fake app server, a Node process, and its hook starts another.
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

const pinned = (page: Page) => page.getByRole('region', { name: 'Waiting for you' })
const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const taskRow = (page: Page, title: string) => transcript(page).getByLabel(`web · ${title}`, { exact: true })

test.describe('Claude task agents', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
  })

  test('a force push by a task agent should ask with an approval card that cannot be allowed for the session', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Approval from web · Force push' })
    await expect(card).toContainText('Bash: git push --force origin HEAD')
    await expect(card).toContainText('On your always-ask list: Force push or delete a remote branch')
    await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BDeny'])
    await card.getByRole('button', { name: 'B. Deny' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Force push' })).toContainText('B · Deny')
    await expect(taskRow(page, 'Force push')).toContainText('Idle')
  })

  test('a force push by the Director should be refused, never run', async ({ page }) => {
    await openChat(page)
    await page.getByRole('textbox', { name: 'Message' }).fill(DIRECTOR_PUSH_REQUEST)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Reply' })).toHaveText('I could not run that, so a task will have to do it.')
    await expect(pinned(page)).toHaveCount(0)
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
    await expect(pinned(page)).toHaveCount(0)
  })

  test('the Director writing in its own folder should run without asking', async ({ page }) => {
    await openChat(page)
    await page.getByRole('textbox', { name: 'Message' }).fill('Keep a note in your own folder.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(transcript(page).getByRole('group', { name: 'Reply' })).toHaveText('Saved the note.')
  })

  test('a delete inside the task folder should run without a card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Clean build', CLEAN_REQUEST)

    await expect(taskRow(page, 'Clean build')).toContainText('Idle')
    await expect(pinned(page)).toHaveCount(0)
  })
})

test.describe('Codex task agents', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    // Only Codex is signed in, so the task agent runs on the real Codex adapter.
    ;({ home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out' }))
  })

  test("a force push by a Codex task agent should ask through BusyBoy's hook", async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

    const card = pinned(page).getByRole('group', { name: 'Approval from web · Force push' })
    await expect(card).toContainText('Bash: git push --force origin HEAD')
    await card.getByRole('button', { name: 'A. Allow' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Force push' })).toContainText('A · Allow')
    await expect(taskRow(page, 'Force push')).toContainText('Idle')
  })
})
