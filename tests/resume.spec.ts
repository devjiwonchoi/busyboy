import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'
import { startStandaloneServer } from './support/standalone-server'

// Agents coming back after the server restarts. Scripts: tests/provider-scripts/task-resume.json,
// director-resume.json, task-agents.json, and director-interrupt.json. Scripted sessions are saved under the temp folder like a provider's
// own session files, so a restarted server resumes them with their history.

const LONG_REQUEST = 'Write the release notes for this week.'
// tests/provider-scripts/task-agents.json: one short turn, after which the agent waits idle.
const QUICK_REQUEST = 'Add a CONTRIBUTING.md that explains how to run the project.'
// tests/provider-scripts/director-interrupt.json: a reply that streams for a while.
const SLOW_DIRECTOR_REQUEST = 'Write a long story about a lighthouse.'
// Must match src/server/director/chat.ts.
const REPLY_CUT_OFF_NOTE = 'BusyBoy restarted before the Director finished replying. Send your message again if you still need an answer.'
const APPROVAL_REQUEST = 'Delete the build folder.'
// Its resumed turn reports signed-out after the session, the way Claude does.
const SIGNED_OUT_REQUEST = 'Summarize the open issues.'
// Must match src/server/tasks.ts.
const RESUME_WORKING_MESSAGE =
  'BusyBoy restarted while you were working, so your last step may not have finished. Check what is already done in the worktree before you continue, so nothing runs twice, then carry on with the task.'
const RESUME_WAITING_MESSAGE =
  'BusyBoy restarted while you were waiting for the user, and your request to them was lost. Ask them again the same way, and do nothing else until they answer.'

type StoredTask = { id: string; title: string; request?: string; agentId: string; sessionId: string | null; activity?: string; note?: string | null }

function storedTasks(home: string): StoredTask[] {
  const file = join(home, 'task-list.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks : []
}

/** The user messages a scripted session received, across every server that ran it. */
function sessionMessages(sessionId: string | null | undefined): string[] {
  if (!sessionId) return []
  const file = join(tmpdir(), 'busyboy-scripted-sessions', `${sessionId}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : []
}

async function createTask(context: BrowserContext, title: string, request: string) {
  const response = await context.request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request } } },
  })
  expect(response.status()).toBe(200)
}

async function openGraph(page: Page) {
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Projects' }).click()
  return sidebar.getByRole('region', { name: 'Project graph' })
}

test('a server that dies mid-task should resume the agent on its session without sending the request again', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    await createTask(context, 'Release notes', LONG_REQUEST)
    await expect.poll(() => storedTasks(home)[0]?.sessionId).toMatch(/^scripted-/)
    const before = storedTasks(home)[0]
    expect(before.activity).toBe('running')
    await expect.poll(() => sessionMessages(before.sessionId)).toEqual([LONG_REQUEST])

    // Killed mid-turn: no shutdown handler runs, as in a crash.
    await server.stop('SIGKILL')
    await server.restart()
    const graph = await openGraph(await context.newPage())

    // A new agent on the same session, told to check its work instead of getting the request again.
    await expect.poll(() => storedTasks(home)[0]?.agentId).not.toBe(before.agentId)
    expect(storedTasks(home)[0].sessionId).toBe(before.sessionId)
    await expect.poll(() => sessionMessages(before.sessionId)).toEqual([LONG_REQUEST, RESUME_WORKING_MESSAGE])
    // Its turn ended without a done record, so it waits on the user.
    await expect(graph.getByRole('group', { name: 'Task Release notes' })).toHaveAttribute('data-status', 'needs-you')
    await expect.poll(() => storedTasks(home)[0]?.activity).toBe('idle')
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('quitting while a task waits for approval should ask again after the restart', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    await createTask(context, 'Clean build', APPROVAL_REQUEST)
    await expect.poll(() => storedTasks(home)[0]?.activity).toBe('needs-you')
    const before = storedTasks(home)[0]

    // A clean stop: the server stops its agents, and that stop must not count as the task stopping.
    await server.stop('SIGTERM')
    expect(storedTasks(home)[0].activity).toBe('needs-you')

    await server.restart()
    const graph = await openGraph(await context.newPage())

    await expect.poll(() => sessionMessages(before.sessionId)).toEqual([APPROVAL_REQUEST, RESUME_WAITING_MESSAGE])
    await expect(graph.getByRole('group', { name: 'Task Clean build' })).toHaveAttribute('data-status', 'needs-you')
    // Waiting on the new approval request, not merely idle.
    await expect.poll(() => storedTasks(home)[0]?.activity).toBe('needs-you')
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('restarting the server should continue the Director conversation', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    await useProjectsHome(context, server.baseURL, [])
    const page = await context.newPage()
    const send = async (text: string) => {
      await page.goto('/')
      await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
      await page.getByRole('textbox', { name: 'Message' }).fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
    }
    const replies = page.getByRole('log', { name: 'Transcript' }).getByLabel('Reply', { exact: true })
    await send('Remember the word lighthouse.')
    await expect(replies).toHaveText(['Noted.'])

    await server.stop('SIGKILL')
    await server.restart()
    await send('What word did I ask you to remember?')

    // Only the same provider session knows the word.
    await expect(replies).toHaveText(['Noted.', 'Lighthouse.'])
    await expect(page.getByRole('log', { name: 'Transcript' }).getByRole('note')).toHaveCount(0)
    await context.close()
  } finally {
    await server.dispose()
  }
})

const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }

/** Marks a task in the list as `fields` say, as a server that stopped at that point left it. */
function patchTask(home: string, id: string, fields: Partial<StoredTask>) {
  const file = join(home, 'task-list.json')
  const list = JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }
  Object.assign(list.tasks.find((task) => task.id === id)!, fields)
  writeFileSync(file, JSON.stringify(list))
}

test('a task whose session cannot be resumed should show as stopped with a note', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web'])
  addRecordTask(home, { project: 'web', projectPath: projects.web, ...FOOTER })
  // The scripted provider fails a `missing-` session the way Claude fails one it no longer has.
  patchTask(home, FOOTER.id, { activity: 'running', sessionId: 'missing-release-notes' })

  const graph = await openGraph(page)

  await expect.poll(() => storedTasks(home)[0]?.activity).toBe('stopped')
  const task = graph.getByRole('group', { name: `Task ${FOOTER.title}` })
  await expect(task).toHaveAttribute('data-status', 'stopped')
  await task.hover()
  await expect(page.getByRole('group', { name: 'Task details' })).toContainText(
    'Could not resume after BusyBoy restarted: the provider no longer has its conversation.',
  )
})

test('a task whose agent never started should start once on the next start', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web'])
  addRecordTask(home, { project: 'web', projectPath: projects.web, ...FOOTER })
  // The server died after saving the task but before the provider confirmed a session.
  patchTask(home, FOOTER.id, { activity: 'running', sessionId: null, request: LONG_REQUEST })

  await openGraph(page)

  await expect.poll(() => storedTasks(home)[0]?.sessionId).toMatch(/^scripted-/)
  await expect.poll(() => sessionMessages(storedTasks(home)[0].sessionId)).toEqual([LONG_REQUEST])
})

test('restarting should leave an idle task idle without starting its agent', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    await createTask(context, 'Contributing guide', QUICK_REQUEST)
    await createTask(context, 'Release notes', LONG_REQUEST)
    const byTitle = (title: string) => storedTasks(home).find((task) => task.title === title)
    await expect.poll(() => byTitle('Contributing guide')?.activity).toBe('idle')
    await expect.poll(() => byTitle('Release notes')?.sessionId).toMatch(/^scripted-/)
    const idle = byTitle('Contributing guide')!

    await server.stop('SIGKILL')
    await server.restart()
    const graph = await openGraph(await context.newPage())

    // The running task resumes, which also shows the resume pass is over.
    await expect.poll(() => sessionMessages(byTitle('Release notes')?.sessionId)).toEqual([LONG_REQUEST, RESUME_WORKING_MESSAGE])
    // The idle one keeps its old agent id and session, and nothing was sent to it.
    expect(byTitle('Contributing guide')).toMatchObject({ agentId: idle.agentId, sessionId: idle.sessionId, activity: 'idle' })
    expect(sessionMessages(idle.sessionId)).toEqual([QUICK_REQUEST])
    // Still waiting on the user (no done record), not stopped.
    await expect(graph.getByRole('group', { name: 'Task Contributing guide' })).toHaveAttribute('data-status', 'needs-you')
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('a provider that cannot start after a restart should leave a note and resume on the next start', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    await createTask(context, 'Release notes', LONG_REQUEST)
    await expect.poll(() => storedTasks(home)[0]?.sessionId).toMatch(/^scripted-/)
    const before = storedTasks(home)[0]

    // The next start has no `claude` anywhere: the real adapter reports it missing once it starts.
    await server.stop('SIGKILL')
    await server.restart({ BUSYBOY_PROVIDER_SCRIPTS: '', BUSYBOY_CLAUDE_PATH: '', PATH: '/usr/bin:/bin' })
    await openGraph(await context.newPage())

    await expect.poll(() => storedTasks(home)[0]?.note).toBe(
      'Could not resume after BusyBoy restarted: The `claude` command was not found on PATH. It is tried again the next time BusyBoy starts.',
    )
    expect(storedTasks(home)[0].activity).toBe('running')
    expect(sessionMessages(before.sessionId)).toEqual([LONG_REQUEST])

    // With the CLI back, the next start resumes it.
    await server.stop('SIGKILL')
    await server.restart()
    await openGraph(await context.newPage())
    await expect.poll(() => sessionMessages(before.sessionId)).toEqual([LONG_REQUEST, RESUME_WORKING_MESSAGE])
    await expect.poll(() => storedTasks(home)[0]?.note).toBeNull()
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('stopping a task and quitting right away should not resume it', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    const page = await context.newPage()
    await page.goto('/')
    const transcript = page.getByRole('log', { name: 'Transcript' })
    await expect(transcript).toHaveAttribute('data-connected', 'true')
    await createTask(context, 'Release notes', LONG_REQUEST)
    // Wait until the provider confirmed its session and got the request: a task is running
    // before that, and a session id read too early is still null.
    await expect.poll(() => sessionMessages(storedTasks(home)[0]?.sessionId)).toEqual([LONG_REQUEST])
    const before = storedTasks(home)[0]
    expect(before.activity).toBe('running')

    await transcript.getByRole('button', { name: 'Stop web · Release notes' }).click()
    await expect.poll(() => storedTasks(home)[0]?.activity).toBe('stopped')
    // Quit at once: the server stops every agent on its way down.
    await page.close()
    await server.stop('SIGTERM')

    await server.restart()
    const graph = await openGraph(await context.newPage())
    await expect(graph.getByRole('group', { name: 'Task Release notes' })).toHaveAttribute('data-status', 'stopped')
    expect(storedTasks(home)[0]).toMatchObject({ agentId: before.agentId, activity: 'stopped' })
    expect(sessionMessages(before.sessionId)).toEqual([LONG_REQUEST])
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('quitting while the Director replies should say so in the chat after the restart', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, [])
    const page = await context.newPage()
    await page.goto('/')
    const transcript = page.getByRole('log', { name: 'Transcript' })
    await expect(transcript).toHaveAttribute('data-connected', 'true')
    await page.getByRole('textbox', { name: 'Message' }).fill(SLOW_DIRECTOR_REQUEST)
    await page.getByRole('button', { name: 'Send' }).click()
    // Streamed reply text means the turn really reached the provider.
    await expect(transcript.getByRole('group', { name: 'Reply in progress' })).not.toBeEmpty()
    await page.close()
    await server.stop('SIGTERM')

    await server.restart()
    const reopened = await context.newPage()
    await reopened.goto('/')
    const after = reopened.getByRole('log', { name: 'Transcript' })
    await expect(after.getByLabel('Your message')).toHaveText(SLOW_DIRECTOR_REQUEST)
    await expect(after.getByRole('note')).toHaveText(REPLY_CUT_OFF_NOTE)
    // The page shows the note before it is saved; a kill before the saved state says the turn
    // ended would show it again, as a real crash in that instant would.
    await expect
      .poll(() => (JSON.parse(readFileSync(join(home, 'director', 'state.json'), 'utf8')) as { turnOpen?: boolean }).turnOpen)
      .toBeUndefined()
    // Shown once: a later start does not repeat it.
    await server.stop('SIGKILL')
    await server.restart()
    await reopened.reload()
    await expect(reopened.getByRole('log', { name: 'Transcript' }).getByRole('note')).toHaveCount(1)
    await context.close()
  } finally {
    await server.dispose()
  }
})

test('a provider that signed out while BusyBoy was closed should leave a note and keep the task for the next start', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, ['web'])
    await createTask(context, 'Open issues', SIGNED_OUT_REQUEST)
    await expect.poll(() => storedTasks(home)[0]?.sessionId).toMatch(/^scripted-/)
    const before = storedTasks(home)[0]

    await server.stop('SIGKILL')
    await server.restart()
    const graph = await openGraph(await context.newPage())

    await expect.poll(() => storedTasks(home)[0]?.note).toBe(
      'Could not resume after BusyBoy restarted: Claude is not signed in. Run `claude` and use /login. It is tried again the next time BusyBoy starts.',
    )
    await expect(graph.getByRole('group', { name: 'Task Open issues' })).toHaveAttribute('data-status', 'stopped')
    // Still marked as working, so the next start tries again instead of leaving it idle.
    expect(storedTasks(home)[0]).toMatchObject({ activity: 'running', sessionId: before.sessionId })
    await context.close()
  } finally {
    await server.dispose()
  }
})
