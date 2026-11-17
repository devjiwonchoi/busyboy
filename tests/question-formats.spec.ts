import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const ENCODED_QUESTION = 'Ask the license question in the encoded shape.'
const OBJECT_QUESTION = 'Ask the color question as one object.'
const MULTI_QUESTION = 'Ask which checks should run, and allow more than one.'
const UNREADABLE_QUESTION = 'Ask something BusyBoy cannot read as a question.'
const PROSE_QUESTION = 'Summarize the latest change as a list.'
const CODEX_LABELED_QUESTION = 'Ask which color, with each choice labeled.'
const CODEX_TITLE_QUESTION = 'Ask which color, using a title and plain options.'
const CODEX_PROSE = 'Summarize what changed in a short list.'

const expect = baseExpect.configure({ timeout: 15_000 })

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

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })
const openCards = (page: Page) => transcript(page).getByRole('group', { name: /^(Question|Approval|Plan|Progress|Done|Pull requests) from / })
const taskRow = (page: Page, title: string) => transcript(page).getByLabel(`web · ${title}`, { exact: true })

test.describe('Claude question formats', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await useProjectsHome(context, baseURL!, ['web'])
  })

  test('clicking the recommended option on a JSON-encoded Claude question should answer the task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Pick a license', ENCODED_QUESTION)

    const card = openCard(page, 'Question from web · Pick a license')
    await expect(card).toContainText('License: Which license should the project use?')
    await expect(card.getByRole('button', { name: 'A. MIT (Recommended)' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'B. Apache-2.0' })).toBeVisible()
    await card.getByRole('button', { name: 'A. MIT (Recommended)' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Pick a license' })).toContainText('A · MIT')
    await expect(taskRow(page, 'Pick a license')).toContainText('Idle')
  })

  test('clicking an option on a Claude question sent as one object should answer the task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Pick a color', OBJECT_QUESTION)

    const card = openCard(page, 'Question from web · Pick a color')
    await expect(card).toContainText('Color: Which color do you prefer?')
    await expect(card.getByRole('button', { name: 'A. Red (Recommended)' })).toContainText('A warm color')
    await card.getByRole('button', { name: 'A. Red (Recommended)' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Pick a color' })).toContainText('A · Red')
    await expect(taskRow(page, 'Pick a color')).toContainText('Idle')
  })

  test('clicking two options on a Claude multi-select question should answer the task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Pick checks', MULTI_QUESTION)

    const card = openCard(page, 'Question from web · Pick checks')
    await expect(card).toContainText('Checks: Which checks should run?')
    await card.getByRole('button', { name: 'A. Lint' }).click()
    await card.getByRole('button', { name: 'B. Typecheck' }).click()
    await card.getByRole('button', { name: 'Answer' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Pick checks' })).toContainText('A · Lint, B · Typecheck')
    await expect(taskRow(page, 'Pick checks')).toContainText('Idle')
  })

  test('an unreadable Claude question should stay a question instead of an approval', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Ask anyway', UNREADABLE_QUESTION)

    const card = openCard(page, 'Question from web · Ask anyway')
    await expect(card).toContainText('Claude asked a question BusyBoy could not read. Reply with the answer.')
    await expect(openCard(page, 'Approval from web · Ask anyway')).toHaveCount(0)
    await card.getByRole('button', { name: 'Stop task' }).click()
    await expect(taskRow(page, 'Ask anyway')).toContainText('Stopped')
  })

  test('a reply that only lists choices in prose should not open a question card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Summarize the change', PROSE_QUESTION)

    await expect(taskRow(page, 'Summarize the change')).toContainText('Idle')
    await expect(openCards(page)).toHaveCount(0)
  })
})

test.describe('Codex question formats', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out' })
  })

  test('clicking an option on a Codex question with labeled choices should answer the task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Pick a color', CODEX_LABELED_QUESTION)

    const card = openCard(page, 'Question from web · Pick a color')
    await expect(card).toContainText('Color: Which color do you prefer?')
    await expect(card.getByRole('button', { name: 'A. Red (Recommended)' })).toContainText('A warm color')
    await expect(card.getByRole('button', { name: 'B. Blue' })).toContainText('A cool color')
    await card.getByRole('button', { name: 'A. Red (Recommended)' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Pick a color' })).toContainText('A · Red')
    await expect(taskRow(page, 'Pick a color')).toContainText('Idle')
  })

  test('clicking an option on a Codex question that uses a title and plain options should answer the task agent', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Pick a title color', CODEX_TITLE_QUESTION)

    const card = openCard(page, 'Question from web · Pick a title color')
    await expect(card).toContainText('Color: Which color do you prefer?')
    await expect(card.getByRole('button', { name: 'A. Red' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'B. Blue' })).toBeVisible()
    await card.getByRole('button', { name: 'A. Red' }).click()

    await expect(transcript(page).getByRole('group', { name: 'Card from web · Pick a title color' })).toContainText('A · Red')
    await expect(taskRow(page, 'Pick a title color')).toContainText('Idle')
  })

  test('a Codex reply that only lists choices in prose should not open a question card', async ({ page, context }) => {
    await openChat(page)
    await createTask(context.request, 'Summarize the change', CODEX_PROSE)

    await expect(taskRow(page, 'Summarize the change')).toContainText('Idle')
    await expect(openCards(page)).toHaveCount(0)
  })
})
