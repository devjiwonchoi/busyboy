import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The phase word on the task row and the project pill. The verifying turn is
// tests/provider-scripts/task-phase.json. The running turn is tests/provider-scripts/work-cards.json.
const VERIFY = 'Verify the site footer and report each step.'
const RUNNING = 'Build the site footer and report each step.'

const expect = baseExpect.configure({ timeout: 15_000 })

async function createTask(request: APIRequestContext, home: string, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
  const { tasks } = JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { title: string }[] }
  expect(tasks.some((task) => task.title === title)).toBe(true)
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })

let home: string

test.beforeEach(async ({ context, baseURL }) => {
  ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
})

test('a verifying task should show Verifying on the row and the pill', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, home, 'Verify the footer', VERIFY)

  const row = transcript(page).getByRole('listitem', { name: 'web · Verify the footer' })
  await expect(row.getByText('Verifying', { exact: true })).toBeVisible()
  await expect(row.locator('[data-phase]')).toHaveAttribute('data-phase', 'verifying')
  await expect(transcript(page).getByRole('group', { name: 'Progress from web · Verify the footer' })).toContainText('Verifying')

  const graph = page.getByRole('region', { name: 'Project graph' })
  const pill = graph.getByRole('group', { name: 'Task Verify the footer' })
  await expect(pill).toHaveAttribute('data-phase', 'verifying')
  await expect(pill).toContainText('Verifying')
  await expect(pill).not.toContainText('Needs you')
})

test('a progress card should not say someone is waiting', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, home, 'Add a footer', RUNNING)

  await expect(transcript(page).getByRole('group', { name: 'Progress from web · Add a footer' })).toBeVisible()
  // The progress card is the task reporting, so the chat list does not say the user is needed.
  await expect(page.getByRole('link', { name: 'BusyBoy, director' })).not.toContainText(/waiting/i)
})

test('a running record between turns should not say Needs you', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, home, 'Add a footer', RUNNING)

  const row = transcript(page).getByRole('listitem', { name: 'web · Add a footer' })
  await expect(row.getByText('Working', { exact: true })).toBeVisible()
  await expect(row).not.toContainText('Needs you')

  const pill = page.getByRole('region', { name: 'Project graph' }).getByRole('group', { name: 'Task Add a footer' })
  await expect(pill).toHaveAttribute('data-status', 'running')
  await expect(pill).toHaveAttribute('data-phase', 'working')
  await expect(pill).toContainText('Working')
  await expect(pill).not.toContainText('Needs you')
})
