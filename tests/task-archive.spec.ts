import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { startStandaloneServer } from './support/standalone-server'

// Archiving and restoring tasks. Scripts: tests/provider-scripts/task-agents.json (a short first
// turn), task-messages.json (a follow-up and a subagent), and task-resume.json (a long turn).

const QUICK_REQUEST = 'Add a CONTRIBUTING.md that explains how to run the project.'
const QUICK_FOLLOW_UP = 'Also add a section on running the tests.'
const LONG_REQUEST = 'Write the release notes for this week.'
const SUBAGENT_REQUEST = 'Say which branch is checked out.'
const KEPT_NOTICE = 'Its worktree was kept because it has changes that are not committed.'

type StoredTask = { id: string; worktree: string; branch: string; sessionId: string | null; activity?: string; archivedAt?: string | null }

function storedTasks(home: string): StoredTask[] {
  const file = join(home, 'task-list.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks : []
}

function sessionMessages(sessionId: string | null | undefined): string[] {
  if (!sessionId) return []
  const file = join(tmpdir(), 'busyboy-scripted-sessions', `${sessionId}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : []
}

async function callTool(request: APIRequestContext, name: string, args: Record<string, string>) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  return { isError: Boolean(body.result.isError), text: body.result.content[0].text }
}

/** A task whose agent finished its first turn, with a record its agent would have written. */
async function finishedTask(request: APIRequestContext, home: string) {
  await callTool(request, 'create_task', { project: 'web', title: 'Contributing guide', request: QUICK_REQUEST })
  await expect.poll(() => storedTasks(home)[0]?.activity).toBe('idle')
  const [task] = storedTasks(home)
  mkdirSync(join(task.worktree, '.jwn', task.id), { recursive: true })
  writeFileSync(join(task.worktree, '.jwn', task.id, 'STATUS.md'), 'Stage: Ship\n')
  return task
}

async function openChatAndGraph(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Projects' }).click()
  return sidebar.getByRole('region', { name: 'Project graph' })
}

const taskLine = (page: Page, name: string) => page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name })

const branches = (repository: string) => execFileSync('git', ['-C', repository, 'branch', '--list', 'busyboy/*'], { encoding: 'utf8' })

test('archiving a finished task should remove its worktree and take it out of the graph, and restoring should bring both back', async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web'])
  const task = await finishedTask(context.request, home)
  const graph = await openChatAndGraph(page)
  const line = taskLine(page, 'web · Contributing guide')
  await expect(graph.getByRole('group', { name: 'Task Contributing guide' })).toBeVisible()

  await line.getByRole('button', { name: 'Archive web · Contributing guide' }).click()

  await expect(line.locator('[data-status]')).toHaveText('Archived')
  await expect(graph.getByRole('group', { name: 'Task Contributing guide' })).toHaveCount(0)
  expect(existsSync(task.worktree)).toBe(false)
  // Its branch and its records are kept.
  expect(branches(projects.web)).toContain(task.branch)
  expect(readFileSync(join(home, 'task-archive', 'web', task.id, '.jwn', task.id, 'STATUS.md'), 'utf8')).toBe('Stage: Ship\n')
  // Nothing to message or open a terminal in while it is archived.
  await expect(line.getByRole('button', { name: 'Message web · Contributing guide' })).toHaveCount(0)
  await expect(line.getByRole('button', { name: 'Select web · Contributing guide' })).toBeDisabled()

  await line.getByRole('button', { name: 'Restore web · Contributing guide' }).click()

  await expect(line.locator('[data-status]')).not.toHaveText('Archived')
  await expect(graph.getByRole('group', { name: 'Task Contributing guide' })).toBeVisible()
  expect(readFileSync(join(task.worktree, '.jwn', task.id, 'STATUS.md'), 'utf8')).toBe('Stage: Ship\n')
  expect(execFileSync('git', ['-C', task.worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe(task.branch)
  expect(existsSync(join(home, 'task-archive', 'web', task.id))).toBe(false)
})

test('archiving a task with uncommitted changes should keep its worktree and say so', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const task = await finishedTask(context.request, home)
  writeFileSync(join(task.worktree, 'CONTRIBUTING.md'), 'Run pnpm dev.\n')
  const graph = await openChatAndGraph(page)
  const line = taskLine(page, 'web · Contributing guide')

  await line.getByRole('button', { name: 'Archive web · Contributing guide' }).click()

  await expect(line.locator('[data-status]')).toHaveText('Archived')
  await expect(page.getByRole('group', { name: 'Tasks' })).toContainText(KEPT_NOTICE)
  await expect(graph.getByRole('group', { name: 'Task Contributing guide' })).toHaveCount(0)
  expect(readFileSync(join(task.worktree, 'CONTRIBUTING.md'), 'utf8')).toBe('Run pnpm dev.\n')
  // The records stay with the worktree that was kept.
  expect(existsSync(join(task.worktree, '.jwn', task.id, 'STATUS.md'))).toBe(true)
  expect(existsSync(join(home, 'task-archive', 'web', task.id))).toBe(false)
})

test('calling message_task for an archived task should restore it and send the message', async ({ context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const task = await finishedTask(context.request, home)
  expect(await callTool(context.request, 'archive_task', { task: task.id })).toEqual({
    isError: false,
    text: `Archived task ${task.id} in web.`,
  })
  expect(existsSync(task.worktree)).toBe(false)
  // Out of the Director's status summary while archived.
  expect((await callTool(context.request, 'task_status', {})).text).not.toContain(task.id)

  const result = await callTool(context.request, 'message_task', { task: task.id, message: QUICK_FOLLOW_UP })

  expect(result.isError).toBe(false)
  expect(storedTasks(home)[0].archivedAt).toBeNull()
  expect(existsSync(join(task.worktree, '.jwn', task.id, 'STATUS.md'))).toBe(true)
  await expect.poll(() => sessionMessages(task.sessionId)).toEqual([QUICK_REQUEST, QUICK_FOLLOW_UP])
  expect((await callTool(context.request, 'task_status', {})).text).toContain(task.id)
})

test('a working task should not be archived, and a finished subagent should', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await callTool(context.request, 'create_task', { project: 'web', title: 'Release notes', request: LONG_REQUEST })
  await callTool(context.request, 'run_subagent', { project: 'web', title: 'Which branch', request: SUBAGENT_REQUEST })
  await openChatAndGraph(page)
  const working = taskLine(page, 'web · Release notes')
  const subagent = taskLine(page, 'web · Which branch')
  await expect(working.locator('[data-status]')).toHaveText('Running')
  await expect(subagent.locator('[data-status]')).toHaveText('Done')
  const [task] = storedTasks(home)

  await expect(working.getByRole('button', { name: 'Archive web · Release notes' })).toHaveCount(0)
  expect(await callTool(context.request, 'archive_task', { task: task.id })).toEqual({
    isError: true,
    text: 'web · Release notes is still working. Stop it before archiving it.',
  })
  expect(existsSync(task.worktree)).toBe(true)

  await subagent.getByRole('button', { name: 'Archive web · Which branch' }).click()
  await expect(subagent.locator('[data-status]')).toHaveText('Archived')
  expect((await callTool(context.request, 'task_status', {})).text).not.toContain('Which branch')
})

test('an archived task that was due to resume should stay put away after a restart', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    const task = await finishedTask(context.request, home)
    // Uncommitted work keeps the worktree, so a resume would have somewhere to run.
    writeFileSync(join(task.worktree, 'CONTRIBUTING.md'), 'Run pnpm dev.\n')
    await callTool(context.request, 'archive_task', { task: task.id })
    await server.stop('SIGTERM')
    // As after a restart whose provider could not start: the task still says it was working.
    const file = join(home, 'task-list.json')
    const list = JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }
    list.tasks[0].activity = 'running'
    writeFileSync(file, JSON.stringify(list))

    await server.restart()
    const page = await context.newPage()
    await openChatAndGraph(page)

    await expect(taskLine(page, 'web · Contributing guide').locator('[data-status]')).toHaveText('Archived')
    // No agent was started for it, and nothing was sent to its session.
    expect(storedTasks(home)[0]).toMatchObject({ archivedAt: expect.any(String) })
    expect(sessionMessages(task.sessionId)).toEqual([QUICK_REQUEST])
    await context.close()
  } finally {
    await server.dispose()
  }
})
