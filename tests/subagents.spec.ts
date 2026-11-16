import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { startStandaloneServer } from './support/standalone-server'

// The Director starts subagents for short actions, played from tests/provider-scripts/director-subagent.json.
const MERGE_REQUEST = 'Merge the open pull request in @web.'
const TYPO_REQUEST = 'Fix the README typo in @web with a subagent.'
const FAILING_REQUEST = 'Check CI in @web.'

type StoredTask = { id: string; project: string; worktree: string; branch: string; kind?: string; activity?: string; reply?: string; note?: string }

const storedTasks = (home: string) =>
  (JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: StoredTask[] }).tasks

async function send(page: Page, text: string) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}


const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const openCard = (page: Page, name: string) => transcript(page).getByRole('group', { name })

test('asking for a merge should start a subagent in the project that asks before merging and shows its result', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web'])
  await send(page, MERGE_REQUEST)

  const line = page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'web · Merge the PR' })
  await expect(line).toContainText('Subagent')
  const card = openCard(page, 'Approval from web · Merge the PR')
  await expect(card).toContainText('Bash: gh pr merge 12 --squash')
  await card.getByRole('button', { name: 'A. Allow' }).click()

  await expect(line.getByLabel('Result')).toHaveText('Merged pull request 12.')
  await expect(line.locator('[data-status]')).toHaveText('Done')
  // No worktree or branch: the subagent ran in the project's own checkout.
  const [task] = storedTasks(home)
  expect(task).toMatchObject({ project: 'web', kind: 'subagent', worktree: projects.web, branch: '' })
  expect(existsSync(join(home, 'task-worktrees'))).toBe(false)

  // The Director learns the result from task_status.
  const response = await context.request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_status', arguments: {} } },
  })
  const status = ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0].text
  expect(status).toContain(`Subagents:\n- ${task.id} "Merge the PR" in web: finished; last reply "Merged pull request 12."`)
})

test('a subagent changing a file with a file tool or the shell should ask first, with no way to allow it for good', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await send(page, TYPO_REQUEST)

  const card = openCard(page, 'Approval from web · Fix the typo')
  await expect(card).toContainText('Change the project checkout as a subagent.')
  await expect(card.getByRole('button', { name: /^[A-C]\. / })).toHaveText(['AAllow', 'BDeny'])
  await card.getByRole('button', { name: 'B. Deny' }).click()
  // Refused the file tool, it tries the shell, which may change the checkout too.
  await expect(card).toContainText("Bash: sed -i '' s/teh/the/ README.md")
  await expect(card).toContainText('Change the project checkout as a subagent.')
  await card.getByRole('button', { name: 'B. Deny' }).click()

  const line = page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'web · Fix the typo' })
  await expect(line.getByLabel('Result')).toHaveText('I cannot edit files here, so the typo needs a task.')
})

test('a finished subagent should end its process and still show its result after a restart', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    const page = await context.newPage()
    await send(page, MERGE_REQUEST)
    await openCard(page, 'Approval from web · Merge the PR').getByRole('button', { name: 'A. Allow' }).click()
    const line = page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'web · Merge the PR' })
    await expect(line.getByLabel('Result')).toHaveText('Merged pull request 12.')
    // Done, with nothing left to stop: its process has ended.
    await expect(line.locator('[data-status]')).toHaveText('Done')
    await expect(line.getByRole('button', { name: 'Stop web · Merge the PR' })).toHaveCount(0)
    await expect.poll(() => storedTasks(home)[0]).toMatchObject({ activity: 'idle', reply: 'Merged pull request 12.' })
    await page.close()
    await server.stop('SIGTERM')

    await server.restart()
    const reopened = await context.newPage()
    await reopened.goto('/')
    const after = reopened.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'web · Merge the PR' })
    await expect(after.getByLabel('Result')).toHaveText('Merged pull request 12.')
    await expect(after.locator('[data-status]')).toHaveText('Done')
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('a subagent whose turn fails should show as stopped, not done', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await send(page, FAILING_REQUEST)

  const line = page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'web · Check CI' })
  await expect(line.locator('[data-status]')).toHaveText('Stopped')
  await expect.poll(() => storedTasks(home)[0]).toMatchObject({ activity: 'stopped', note: 'The provider stopped answering.' })
})
