import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { createGitRepository } from './support/test-home'


const QUESTION = 'What do you manage?'
const WORK = 'Add a contributing guide.'

type StoredManager = { id: string; name: string; project: string }
type StoredTask = { id: string; project: string; title: string; chat?: string | null }

const settingsOf = (home: string) =>
  JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')) as { managers?: StoredManager[]; projects: { name: string }[] }

function storedTasks(home: string): StoredTask[] {
  const file = join(home, 'task-list.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks : []
}

function addManager(home: string, manager: StoredManager) {
  const file = join(home, 'app-settings.json')
  const settings = settingsOf(home)
  const managers = [...(settings.managers ?? []), { ...manager, createdAt: new Date(0).toISOString() }]
  writeFileSync(file, `${JSON.stringify({ ...settings, managers }, null, 2)}\n`)
}

const chatList = (page: Page) => page.getByRole('navigation', { name: 'Chats' })
const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })

async function openChat(page: Page, manager?: string) {
  await page.goto(manager ? `/?manager=${manager}` : '/')
  await expect(transcript(page)).toHaveAttribute('data-connected', 'true')
  await expect(chatList(page)).toHaveAttribute('data-loaded', 'true')
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function rpc(request: APIRequestContext, manager: string, method: string, params: Record<string, unknown> = {}) {
  const response = await request.post(`/api/mcp?manager=${manager}`, { data: { jsonrpc: '2.0', id: 1, method, params } })
  return { status: response.status(), body: response.status() === 200 ? await response.json() : null }
}

test('creating a manager for a project should open its chat and list it', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await openChat(page)
  await expect(chatList(page).getByText('No managers yet.')).toBeVisible()

  await chatList(page).getByRole('button', { name: 'New manager' }).click()
  const form = page.getByRole('dialog', { name: 'New manager' })
  await form.getByRole('textbox', { name: 'Name' }).fill('Webby')
  await form.getByRole('radio', { name: 'web' }).click()
  await form.getByRole('button', { name: 'Create manager' }).click()

  await expect(transcript(page).getByText('Webby, manager of web')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', 'Message Webby')
  await expect(chatList(page).getByRole('link', { name: 'Webby' })).toHaveAttribute('aria-current', 'page')
  const [manager] = settingsOf(home).managers ?? []
  expect(manager).toMatchObject({ name: 'Webby', project: 'web' })
  expect(page.url()).toContain(`manager=${manager.id}`)
})

test('creating a manager for a folder BusyBoy does not know should add the project too', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const docs = createGitRepository('docs')
  await openChat(page)

  await chatList(page).getByRole('button', { name: 'New manager' }).click()
  const form = page.getByRole('dialog', { name: 'New manager' })
  await form.getByRole('radio', { name: 'Another folder' }).click()
  await form.getByRole('textbox', { name: 'Folder path' }).fill(docs)
  await form.getByRole('button', { name: 'Create manager' }).click()

  await expect(transcript(page).getByText('docs, manager of docs')).toBeVisible()
  const settings = settingsOf(home)
  expect(settings.projects.map(({ name }) => name)).toEqual(['web', 'docs'])
  expect(settings.managers).toMatchObject([{ name: 'docs', project: 'docs' }])
})

test('a project that has a manager should not be offered for a second one', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  addManager(home, { id: 'webby', name: 'Webby', project: 'web' })
  await openChat(page)

  await chatList(page).getByRole('button', { name: 'New manager' }).click()
  const form = page.getByRole('dialog', { name: 'New manager' })
  await expect(form.getByRole('radio', { name: 'api' })).toBeVisible()
  await expect(form.getByRole('radio', { name: 'web' })).toHaveCount(0)
})

test("a message to a manager should be answered in its chat and stay out of the Director's", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  addManager(home, { id: 'webby', name: 'Webby', project: 'web' })
  await openChat(page, 'webby')

  await send(page, QUESTION)

  await expect(transcript(page).getByLabel('Reply', { exact: true })).toContainText('You are Webby, the manager of the web project')
  await expect(transcript(page)).toHaveAttribute('data-status', 'idle')
  expect(readFileSync(join(home, 'managers', 'webby', 'transcript.jsonl'), 'utf8')).toContain(QUESTION)
  await expect(chatList(page).getByRole('listitem', { name: 'Webby' })).toContainText('You are Webby')

  await chatList(page).getByRole('link', { name: 'director' }).click()
  await expect(transcript(page)).toHaveAttribute('data-connected', 'true')
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', 'Message BusyBoy')
  await expect(transcript(page).getByLabel('Your message')).toHaveCount(0)
  expect(existsSync(join(home, 'director', 'transcript.jsonl'))).toBe(false)
})

test('a manager asked for work should create the task in its own project and show it in its chat', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['api', 'web'])
  addManager(home, { id: 'webby', name: 'Webby', project: 'web' })
  await openChat(page, 'webby')

  await send(page, WORK)

  await expect(transcript(page).getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'Contributing guide' })).toBeVisible()
  await expect(transcript(page).getByLabel('Reply', { exact: true })).toHaveText('I started a task for the contributing guide.')
  expect(storedTasks(home)).toMatchObject([{ project: 'web', title: 'Contributing guide', chat: 'webby' }])

  await openChat(page)
  await expect(transcript(page).getByRole('group', { name: 'Tasks' })).toHaveCount(0)
})

test("a manager's tools should take no project and refuse another project's task", async ({ context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['api', 'web'])
  addManager(home, { id: 'webby', name: 'Webby', project: 'web' })
  const director = await context.request.post('/api/mcp', {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_task', arguments: { project: 'api', title: 'Health endpoint', request: 'Add a CONTRIBUTING.md that explains how to run the project.' } },
    },
  })
  expect(director.status()).toBe(200)
  const [apiTask] = storedTasks(home)

  const list = await rpc(context.request, 'webby', 'tools/list')
  const tools = list.body.result.tools as { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[]
  expect(tools.map(({ name }) => name)).not.toContain('list_projects')
  const createTask = tools.find(({ name }) => name === 'create_task')!
  expect(Object.keys(createTask.inputSchema.properties)).toEqual(['title', 'request'])
  expect(createTask.inputSchema.required).toEqual(['title', 'request'])

  const message = await rpc(context.request, 'webby', 'tools/call', { name: 'message_task', arguments: { task: apiTask.id, message: 'Hello.' } })
  expect(message.body.result.isError).toBe(true)
  expect(message.body.result.content[0].text).toContain('belongs to api, which you do not manage')

  expect((await rpc(context.request, 'nobody', 'tools/list')).status).toBe(403)
})

test("removing a manager should take it off the list and show its tasks in the Director's chat", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  addManager(home, { id: 'webby', name: 'Webby', project: 'web' })
  const created = await rpc(context.request, 'webby', 'tools/call', {
    name: 'create_task',
    arguments: { title: 'Contributing guide', request: 'Add a CONTRIBUTING.md that explains how to run the project.' },
  })
  expect(created.body.result.isError).toBeFalsy()
  await openChat(page, 'webby')

  const item = chatList(page).getByRole('listitem', { name: 'Webby' })
  await item.hover()
  await item.getByRole('button', { name: 'Remove Webby' }).click()
  await page.getByRole('alertdialog', { name: 'Remove Webby?' }).getByRole('button', { name: 'Remove' }).click()

  await expect(chatList(page).getByText('No managers yet.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', 'Message BusyBoy')
  await expect(transcript(page).getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'Contributing guide' })).toBeVisible()
  expect(storedTasks(home)).toMatchObject([{ title: 'Contributing guide', chat: null }])
  expect(settingsOf(home).managers).toEqual([])
  expect(settingsOf(home).projects.map(({ name }) => name)).toEqual(['web'])
})
