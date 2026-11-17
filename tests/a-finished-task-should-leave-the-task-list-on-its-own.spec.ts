import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test'
import { homeRecordFolder } from './support/record-tasks'
import { useProjectsHome } from './support/projects-home'

// A task whose agent finishes with State done and no pull requests puts itself
// away. The turns are tests/provider-scripts/auto-archive.json. Nothing here
// clicks Archive.

const START = 'Publish the release checklist.'
const FINISH = 'Mark the release checklist done.'

const expect = baseExpect.configure({ timeout: 15_000 })

type StoredTask = { id: string; worktree: string; branch: string; project: string }

function storedTask(home: string, title: string) {
  const { tasks } = JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: (StoredTask & { title: string })[] }
  const task = tasks.find((item) => item.title === title)
  if (!task) throw new Error(`No task titled ${title}.`)
  return task
}

async function createTask(request: APIRequestContext, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
}

async function taskStatus(request: APIRequestContext) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_status', arguments: {} } },
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0].text
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

const taskLine = (page: Page, name: string) => page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name })

test('a finished task should leave the task list on its own', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  await createTask(context.request, 'Release checklist', START)
  const task = storedTask(home, 'Release checklist')
  const line = taskLine(page, 'web · Release checklist')

  // The first turn is still working, so the task stays in the list.
  await expect(line.locator('[data-status]')).toHaveText('Working')
  await expect(line.getByRole('button', { name: 'Archive web · Release checklist' })).toBeVisible()
  expect(existsSync(task.worktree)).toBe(true)
  expect(await taskStatus(context.request)).toContain(task.id)

  await line.getByRole('button', { name: 'Message web · Release checklist' }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill(FINISH)
  await page.getByRole('button', { name: 'Send' }).click()

  // Nobody clicked Archive. The finished task leaves the active list.
  await expect(line.locator('[data-status]')).toHaveText('Archived')
  await expect(line.getByRole('button', { name: 'Archive web · Release checklist' })).toHaveCount(0)
  await expect(line.getByRole('button', { name: 'Restore web · Release checklist' })).toBeVisible()
  expect(existsSync(task.worktree)).toBe(false)
  // The branch and the record stay, so a later message can bring the task back.
  expect(execFileSync('git', ['-C', projects.web, 'branch', '--list', 'busyboy/*'], { encoding: 'utf8' })).toContain(task.branch)
  const records = await homeRecordFolder(home, task)
  expect(readFileSync(join(records, 'STATUS.md'), 'utf8')).toContain('State: done')
  expect(await taskStatus(context.request)).not.toContain(task.id)
})
