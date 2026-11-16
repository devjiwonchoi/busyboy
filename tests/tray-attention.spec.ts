import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

// What the desktop tray and notifications read: the attention stream
// (src/app/api/attention/events). The Electron side itself is covered by
// `--self-check` (electron/self-check.ts).

const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }
const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }
// Recorded from real Claude (tests/provider-scripts/claude-approval.json): the agent asks before running Bash.
const APPROVAL_REQUEST = 'Run the shell command `touch notes.txt` with the Bash tool, then reply with exactly: Created notes.txt.'
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'

type Update =
  | { type: 'state'; tasks: { taskId: string; project: string; title: string }[] }
  | { type: 'event'; event: { kind: string; taskId?: string; project?: string; title?: string } }

/** Follows the attention stream from the page, the way the desktop app does from its main process. */
async function followAttention(page: Page) {
  await page.goto('/setup')
  await page.evaluate(() => {
    const updates: unknown[] = []
    ;(window as unknown as { updates: unknown[] }).updates = updates
    const source = new EventSource('/api/attention/events')
    source.onmessage = (message) => updates.push(JSON.parse(message.data))
  })
  return {
    updates: () => page.evaluate(() => (window as unknown as { updates: Update[] }).updates),
  }
}

const events = (updates: Update[]) => updates.flatMap((update) => (update.type === 'event' ? [update.event] : []))
const lastState = (updates: Update[]) => updates.filter((update) => update.type === 'state').at(-1)

test('a task that finishes or starts needing the user should be announced, with only its title', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  addRecordTask(home, { project: 'api', projectPath: projects.api, ...HEALTH })
  const footer = addRecordTask(home, { project: 'web', projectPath: projects.web, ...FOOTER })
  const stream = await followAttention(page)

  // Connecting reports what waits now and announces nothing old.
  await expect.poll(async () => lastState(await stream.updates())?.tasks).toEqual([{ taskId: FOOTER.id, project: 'web', title: FOOTER.title }])
  expect(events(await stream.updates())).toEqual([])

  const status = (state: string, second: string) =>
    writeFileSync(
      join(footer.records, 'STATUS.md'),
      ['# STATUS: show-health-footer', '', '- Stage: Ship', `- State: ${state}`, '', '| Todo | Result |', '|---|---|', '| 1 | done |', `| 2 | ${second} |`, '| 3 | done |', ''].join('\n'),
    )
  status('done', 'done')
  await expect.poll(async () => events(await stream.updates())).toEqual([{ kind: 'task-done', taskId: FOOTER.id, project: 'web', title: FOOTER.title }])
  await expect.poll(async () => lastState(await stream.updates())?.tasks).toEqual([])

  status('needs you', 'waiting on the user')
  await expect.poll(async () => events(await stream.updates()).at(-1)).toEqual({
    kind: 'task-needs-you',
    taskId: FOOTER.id,
    project: 'web',
    title: FOOTER.title,
  })
})

test('a task agent asking for approval should put the task on the needs-you list', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  const stream = await followAttention(page)
  await expect.poll(async () => lastState(await stream.updates())?.tasks).toEqual([])

  const response = await context.request.post('/api/mcp', {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_task', arguments: { project: 'web', title: 'Touch notes', request: APPROVAL_REQUEST } },
    },
  })
  expect(response.status()).toBe(200)

  await expect.poll(async () => lastState(await stream.updates())?.tasks.map(({ title }) => title)).toEqual(['Touch notes'])
  const announced = events(await stream.updates())
  expect(announced).toEqual([expect.objectContaining({ kind: 'task-needs-you', project: 'web', title: 'Touch notes' })])
  // Only ids, the project, and the title: nothing the agent wrote (the approval's command) is sent.
  expect(JSON.stringify(await stream.updates())).not.toContain('touch notes.txt')
})

test('a Director reply should be announced', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [])
  const stream = await followAttention(page)
  await expect.poll(async () => (await stream.updates()).length).toBeGreaterThan(0)

  const chat = await context.newPage()
  await chat.goto('/')
  await expect(chat.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await chat.getByRole('textbox', { name: 'Message' }).fill(PLAIN_PROMPT)
  await chat.getByRole('button', { name: 'Send' }).click()
  await expect(chat.getByRole('log', { name: 'Transcript' }).getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')

  await expect.poll(async () => events(await stream.updates())).toEqual([{ kind: 'director-replied' }])
})
