import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The plan turn is tests/provider-scripts/task-cards.json.
const REQUEST = 'Add a footer with the project name to the web app.'

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

test('a plan card should say Aligning on its face', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, 'Add a footer', REQUEST)

  const card = page.getByRole('log', { name: 'Transcript' }).getByRole('group', { name: 'Plan from web · Add a footer' })
  await expect(card.getByText('Aligning', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
