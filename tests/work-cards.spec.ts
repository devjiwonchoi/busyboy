import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// A task whose records move from a running step to a finished stack of pull requests.
// The script is tests/provider-scripts/work-cards.json. Merges go to tests/fake-gh/gh.
const REQUEST = 'Build the site footer and report each step.'
const SHIP = 'Ship the footer.'

const expect = baseExpect.configure({ timeout: 15_000 })

// The approved mockup is dark. The app follows the operating system's color scheme.
test.use({ colorScheme: 'dark' })

async function createTask(request: APIRequestContext, home: string, title: string, text: string) {
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

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })

let home: string

test.beforeEach(async ({ context, baseURL }) => {
  ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
})

test('a running step should show a spinner while earlier steps stay checked', async ({ page, context }) => {
  await openChat(page)
  await createTask(context.request, home, 'Add a footer', REQUEST)

  const card = openCard(page, 'Progress from web · Add a footer')
  const steps = card.getByRole('listitem')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toContainText('Done: Footer component')
  await expect(steps.nth(0).locator('[data-step-mark=done]')).toBeVisible()
  await expect(steps.nth(0).locator('[data-slot=spinner]')).toHaveCount(0)
  await expect(steps.nth(1)).toContainText('Running: Wire the pages')
  await expect(steps.nth(1).locator('[data-slot=spinner]')).toBeVisible()
  await expect(steps.nth(2)).toContainText('Not started: Deliver')
  await expect(steps.nth(2).locator('[data-step-mark=pending]')).toBeVisible()
  await expect(steps.nth(2).locator('[data-slot=spinner]')).toHaveCount(0)
  await expect(card.getByText('web', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Reply' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Stop task' })).toHaveCount(0)

  await card.getByRole('button', { name: 'View details' }).click()
  const details = page.getByRole('dialog', { name: 'Add a footer' })
  await expect(details.getByRole('listitem').nth(1)).toContainText('Running')
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  await transcript(page).screenshot({ path: '/opt/cursor/artifacts/progress-card.png' })
})

test('clicking Merge in order should merge pull requests from the base of the stack', async ({ page, context }) => {
  await openChat(page)
  const task = await createTask(context.request, home, 'Add a footer', REQUEST)
  await expect(openCard(page, 'Progress from web · Add a footer')).toBeVisible()
  // The progress card does not take the composer, so the task can be told to ship.
  // The turn ended, and the record still says the work is running, so the row says Working.
  await expect(transcript(page).getByLabel('web · Add a footer', { exact: true })).toContainText('Working')

  await transcript(page).getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Message web · Add a footer' }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill(SHIP)
  await page.getByRole('button', { name: 'Send' }).click()

  const done = openCard(page, 'Done from web · Add a footer')
  await expect(done).toHaveAttribute('data-variant', 'line')
  await expect(done).toContainText('Add a footer')
  await expect(done).toContainText('· Done')
  await expect(done.getByRole('button', { name: 'View plan' })).toBeVisible()
  await expect(done.getByRole('button', { name: 'Reply' })).toHaveCount(0)
  await expect(done.getByRole('button', { name: 'Stop task' })).toHaveCount(0)
  await expect(openCard(page, 'Progress from web · Add a footer')).toHaveCount(0)
  // Finishing replaces the progress card. It does not leave a second closed Done card.
  await expect(transcript(page).getByRole('group', { name: 'Card from web · Add a footer' })).toHaveCount(0)

  await done.getByRole('button', { name: 'View plan' }).click()
  await expect(page.getByRole('dialog', { name: 'Add a site footer' })).toContainText('a footer on every page')
  await page.keyboard.press('Escape')

  const pulls = openCard(page, 'Pull requests from web · Add a footer')
  await expect(pulls).toContainText('Stacked PRs (2)')
  await expect(pulls).toContainText('Approved to merge. This does not deploy.')
  const rows = pulls.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('#12 Add a footer')
  await expect(rows.nth(0)).toContainText('Checks passing')
  await expect(rows.nth(0).getByRole('link', { name: '#12 Add a footer' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/12')
  await expect(rows.nth(0).getByRole('link', { name: '#12 Add a footer' })).toHaveAttribute('target', '_blank')
  await expect(rows.nth(1)).toContainText('#13 Show the year')
  await expect(rows.nth(1)).toContainText('Checks pending')
  await expect(rows.nth(1).getByRole('link', { name: '#13 Show the year' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/13')
  await expect(rows.nth(1).getByRole('link', { name: '#13 Show the year' })).toHaveAttribute('target', '_blank')
  await expect(pulls.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/12')
  await expect(pulls.getByRole('link', { name: 'Open' })).toHaveCount(1)
  await expect(pulls.getByRole('button', { name: 'Reply' })).toHaveCount(0)
  await expect(pulls.getByRole('button', { name: 'Stop task' })).toHaveCount(0)
  // The card is on screen and nothing has merged: the click is what merges.
  const log = join(task.worktree, '.gh-merge.log')
  expect(existsSync(log)).toBe(false)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  await transcript(page).screenshot({ path: '/opt/cursor/artifacts/done-and-pull-requests.png' })

  const popupPromise = page.waitForEvent('popup')
  await pulls.getByRole('link', { name: 'Open' }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://github.com/acme/web/pull/12')
  await popup.close()
  expect(existsSync(log)).toBe(false)

  await pulls.getByRole('button', { name: 'Merge in order' }).click()

  await expect(pulls).toHaveCount(0)
  await expect(transcript(page).getByRole('group', { name: 'Card from web · Add a footer' }).filter({ hasText: 'Merged in order' })).toBeVisible()
  await expect(done).toContainText('Add a footer · Done')
  expect(readFileSync(log, 'utf8')).toBe('pr merge 12 --merge\npr merge 13 --merge\n')
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  await transcript(page).screenshot({ path: '/opt/cursor/artifacts/merged-in-order.png' })
})
