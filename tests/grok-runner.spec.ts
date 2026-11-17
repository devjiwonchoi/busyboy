import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { fakeGrokURL } from './fake-grok/fake-grok'
import { useProjectsHome } from './support/projects-home'

// The real Grok adapter, driven through the chat against tests/fake-grok/grok.mjs.
// The fake speaks ACP on stdio and does not use the network. Only Grok is signed in,
// except the settings journey, which signs Claude in too so a default can be chosen.
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const FORCE_PUSH_REQUEST = 'Force push the branch to origin.'
const DIRECTOR_PUSH_REQUEST = 'Force push the main branch yourself.'
const CLEAN_REQUEST = 'Remove the build folder.'
const MCP_PROMPT = 'Which MCP servers are connected?'
const expect = baseExpect.configure({ timeout: 15_000 })

test.use({ baseURL: fakeGrokURL })

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function createTask(request: APIRequestContext, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })
const taskRow = (page: Page, title: string) => transcript(page).getByLabel(`web · ${title}`, { exact: true })

/** What the fake recorded after BusyBoy allowed a command in this home's task worktree. */
function allowedCommand(home: string) {
  const root = join(home, 'task-worktrees', 'web')
  if (!existsSync(root)) return undefined
  const files = readdirSync(root).map((id) => join(root, id, '.grok-ran')).filter((file) => existsSync(file))
  return files.length === 1 ? readFileSync(files[0], 'utf8') : undefined
}

test('sending a message to a Grok Director should show the reply', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [], { claude: 'signed-out', grok: 'signed-in' })
  await openChat(page)
  await send(page, PLAIN_PROMPT)

  const log = transcript(page)
  await expect(log.getByLabel('Your message')).toHaveText(PLAIN_PROMPT)
  await expect(log.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
  await expect(log).toHaveAttribute('data-status', 'idle')
})

test('a force push by a Grok task agent should ask with an approval card, and denying it should stop the push', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out', grok: 'signed-in' })
  await openChat(page)
  await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

  const card = openCard(page, 'Approval from web · Force push')
  await expect(card).toContainText('Bash: git push --force origin HEAD')
  await expect(card).toContainText('On your always-ask list: Force push or delete a remote branch')
  await card.getByRole('button', { name: 'C. Deny' }).click()

  await expect(transcript(page).getByRole('group', { name: 'Card from web · Force push' })).toContainText('C · Deny')
  await expect(taskRow(page, 'Force push')).toContainText('Idle')
  expect(allowedCommand(home)).toBeUndefined()
})

test('always allowing a Grok force push should skip that command and ask for a different branch', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out', grok: 'signed-in' })
  await openChat(page)
  await createTask(context.request, 'Force push', FORCE_PUSH_REQUEST)

  const card = openCard(page, 'Approval from web · Force push')
  await expect(card).toContainText('Bash: git push --force origin HEAD')
  await card.getByRole('button', { name: 'B. Always allow this exact command' }).click()

  // The same push is asked again and allowed from the earlier answer, so the next card is the other branch.
  await expect(card).toContainText('Bash: git push --force origin release')
  await card.getByRole('button', { name: 'C. Deny' }).click()
  await expect(taskRow(page, 'Force push')).toContainText('Idle')
})

test('a delete inside the task folder by a Grok task agent should run without a card', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out', grok: 'signed-in' })
  await openChat(page)
  await createTask(context.request, 'Clean build', CLEAN_REQUEST)

  await expect(taskRow(page, 'Clean build')).toContainText('Idle')
  await expect(transcript(page).getByRole('group', { name: /Approval from / })).toHaveCount(0)
  expect(allowedCommand(home)).toBe('rm -rf build\n')
})

test('a Grok Director should be given the busyboy MCP server', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [], { claude: 'signed-out', grok: 'signed-in' })
  await openChat(page)
  await send(page, MCP_PROMPT)

  const log = transcript(page)
  await expect(log.getByLabel('Reply', { exact: true })).toHaveText('busyboy http with headers.')
  await expect(log.getByLabel('Reply', { exact: true })).not.toContainText('busyboy-test-home')
  await expect(log).toHaveAttribute('data-status', 'idle')
})

test('a force push by a Grok Director should be refused without a card', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [], { claude: 'signed-out', grok: 'signed-in' })
  await openChat(page)
  await send(page, DIRECTOR_PUSH_REQUEST)

  const log = transcript(page)
  await expect(log.getByLabel('Reply', { exact: true })).toHaveText('Declined the push.')
  await expect(log.getByRole('group', { name: /Approval from / })).toHaveCount(0)
  await expect(log).toHaveAttribute('data-status', 'idle')
})

test('a lost Grok session should start a new conversation and still answer', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, [], { claude: 'signed-out', grok: 'signed-in' })
  mkdirSync(join(home, 'director'))
  writeFileSync(join(home, 'director', 'state.json'), JSON.stringify({ provider: 'grok', sessionId: 'missing-old-session' }))
  await openChat(page)
  await send(page, PLAIN_PROMPT)

  const log = transcript(page)
  await expect(log.getByRole('note')).toHaveText('The previous conversation could not be resumed. Started a new one.')
  await expect(log.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
  const state = JSON.parse(readFileSync(join(home, 'director', 'state.json'), 'utf8')) as { sessionId: string }
  expect(state.sessionId).not.toBe('missing-old-session')
})

test('choosing Grok as the default agent should save it', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, [], { claude: 'signed-in', grok: 'signed-in' })
  await page.goto('/settings?section=agents')

  await expect(page.getByRole('list', { name: 'Agents' })).toContainText('Grok')
  await page.getByRole('radio', { name: 'Use Grok by default' }).click()

  await expect.poll(() => JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')).defaultProvider).toBe('grok')
  await expect(page.getByRole('radio', { name: 'Use Grok by default' })).toBeChecked()
})
