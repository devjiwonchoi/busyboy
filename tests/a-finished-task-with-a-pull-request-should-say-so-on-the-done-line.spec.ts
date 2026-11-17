import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The two turns are tests/provider-scripts/work-cards.json. One check is still pending.
const REQUEST = 'Build the site footer and report each step.'
const SHIP = 'Ship the footer.'

const expect = baseExpect.configure({ timeout: 15_000 })

async function createTask(request: APIRequestContext, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test.beforeEach(async ({ context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
})

test('a finished task with a pull request should say so on the done line', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, 'Add a footer', REQUEST)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByRole('group', { name: 'Progress from web · Add a footer' })).toBeVisible()
  await transcript.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Message web · Add a footer' }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill(SHIP)
  await page.getByRole('button', { name: 'Send' }).click()

  const done = transcript.getByRole('group', { name: 'Done from web · Add a footer' })
  await expect(transcript.getByRole('group', { name: 'Pull requests from web · Add a footer' })).toBeVisible()
  await expect(done).toContainText('PR · 1 check pending')
  await expect(done).not.toContainText('· Done')
})
