import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The agent writes ALIGN.md, including one flowchart and one fence Mermaid cannot parse.
// The script is tests/provider-scripts/plan-mermaid.json.
const REQUEST = 'Add a footer and show the end-to-end workflow.'

const expect = baseExpect.configure({ timeout: 15_000 })

// The app follows the operating system's color scheme. The diagram uses that theme.
test.use({ colorScheme: 'dark' })

async function createTask(request: APIRequestContext, home: string, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
  const { tasks } = JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { title: string; worktree: string; id: string }[] }
  return tasks.find((task) => task.title === title)!
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })

let home: string

test.beforeEach(async ({ context, baseURL }) => {
  ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
})

test('viewing plan details should render a mermaid diagram and keep an invalid diagram as code', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, home, 'Add a footer workflow', REQUEST)

  const card = openCard(page, 'Plan from web · Add a footer workflow')
  await expect(card).toContainText('When done: a footer with the project name on every page.')
  // The card is the summary. The diagram stays in the plan text.
  await expect(card.locator('svg')).toHaveCount(0)
  await card.getByRole('button', { name: 'View details' }).click()

  const details = page.getByRole('dialog', { name: 'Add a site footer' })
  await expect(details.getByRole('heading', { name: 'E2E workflow' })).toBeVisible()
  const diagram = details.locator('[data-mermaid=diagram] svg')
  await expect(diagram).toBeVisible()
  await expect(diagram).toContainText('see-the-footer.spec.ts')
  await expect(diagram).toContainText('Open the app')
  await expect(diagram).toContainText('See the footer')

  const source = details.locator('[data-mermaid=code]')
  await expect(source.locator('[data-streamdown=code-block]')).toBeVisible()
  await expect(source).toContainText('not a flowchart')
  await expect(source.locator('[data-mermaid=diagram]')).toHaveCount(0)
  await expect(details.locator('svg', { hasText: 'not a flowchart' })).toHaveCount(0)
})
