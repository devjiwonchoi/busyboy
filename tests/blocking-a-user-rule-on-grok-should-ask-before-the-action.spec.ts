import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { fakeGrokURL } from './fake-grok/fake-grok'
import { useProjectsHome } from './support/projects-home'

const RULES = join(__dirname, 'fixtures', 'user-rules')

const expect = baseExpect.configure({ timeout: 15_000 })

test.use({ baseURL: fakeGrokURL })

function installRule(home: string, name: string) {
  const folder = join(home, 'user-jwn')
  mkdirSync(folder, { recursive: true })
  copyFileSync(join(RULES, name), join(folder, name))
}

function allowedCommand(home: string) {
  const root = join(home, 'task-worktrees', 'web')
  if (!existsSync(root)) return undefined
  const files = readdirSync(root).map((id) => join(root, id, '.grok-ran')).filter((file) => existsSync(file))
  return files.length === 1 ? readFileSync(files[0], 'utf8') : undefined
}

async function createTask(request: APIRequestContext, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })
const taskRow = (page: Page, title: string) => transcript(page).getByLabel(`web · ${title}`, { exact: true })
const signIn = { claude: 'signed-out' as const, codex: 'signed-out' as const, grok: 'signed-in' as const }

test('a command matching a YAML rule should ask through Grok permission', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], signIn)
  installRule(home, 'do-not-print.yaml')
  await openChat(page)
  await createTask(context.request, 'Print the token', 'Print the secret token with Grok.')

  const card = openCard(page, 'Approval from web · Print the token')
  await expect(card).toContainText('Bash: echo secret-token')
  await expect(card).toContainText('Blocked by a rule in ~/.jwn: Do not print the secret token (Bash(echo secret-token*))')
  await expect(card).toContainText('The token must stay out of the terminal.')
  await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BAlways allow this exact command', 'CDeny'])
  await card.getByRole('button', { name: 'C. Deny' }).click()

  await expect(transcript(page).getByRole('group', { name: 'Card from web · Print the token' })).toContainText('C · Deny')
  await expect(taskRow(page, 'Print the token')).toContainText('Idle')
  expect(allowedCommand(home)).toBeUndefined()
})

test('a command matching no Grok rule should run without an approval card', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], signIn)
  installRule(home, 'do-not-print.yaml')
  await openChat(page)
  await createTask(context.request, 'Print the directory', 'Print the working directory with Grok.')

  await expect(taskRow(page, 'Print the directory')).toContainText('Idle')
  await expect(transcript(page).getByRole('group', { name: /^(Question|Approval|Plan|Progress|Done|Pull requests) from / })).toHaveCount(0)
  expect(allowedCommand(home)).toBe('pwd\n')
})

test('a rule file Grok cannot read should block the command and ask', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], signIn)
  installRule(home, 'broken.yaml')
  await openChat(page)
  await createTask(context.request, 'Say hello', 'Say hello with Grok.')

  const card = openCard(page, 'Approval from web · Say hello')
  await expect(card).toContainText('Bash: echo hello')
  await expect(card).toContainText('BusyBoy could not check the rules in ~/.jwn, so this action is blocked.')
  await expect(card).toContainText('broken.yaml')
  await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BDeny'])
  await card.getByRole('button', { name: 'B. Deny' }).click()

  await expect(transcript(page).getByRole('group', { name: 'Card from web · Say hello' })).toContainText('B · Deny')
  await expect(taskRow(page, 'Say hello')).toContainText('Idle')
  expect(allowedCommand(home)).toBeUndefined()
})
