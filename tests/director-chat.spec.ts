import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Director prompts recorded from real Claude runs (tests/provider-scripts/director-*.json);
// the question-tool, interrupt, batch, long-chat, and text-blocks scripts are hand-written.
const QUESTION = 'What does git worktree do? Answer in one sentence.'
const ONE_PROJECT_WORK = 'In @web, add a CONTRIBUTING.md that explains how to run the project.'
const TWO_PROJECT_WORK = 'Add a /health endpoint to @api and show its status in the footer of @web.'
const SLOW_REQUEST = 'Write a long story about a lighthouse.'
const INTERRUPTING_REQUEST = 'Never mind, just say hi.'
const LONG_REQUEST = 'Tell me everything about lighthouses.'
const AMBIGUOUS_REQUEST = 'Fix the login page.'
const MULTI_BLOCK_REQUEST = 'Check what is in @web.'

type StoredTask = { id: string; project: string; title: string; worktree: string; branch: string; agentId: string }

function storedTasks(home: string): StoredTask[] {
  const file = join(home, 'task-list.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks : []
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('asking a question should answer without creating a task', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await openChat(page)

  await send(page, QUESTION)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Your message')).toHaveText(QUESTION)
  await expect(transcript.getByLabel('Reply', { exact: true })).toContainText('check out more than one branch')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
  await expect(transcript.getByRole('group', { name: 'Tasks' })).toHaveCount(0)
  expect(storedTasks(home)).toEqual([])
  expect(readFileSync(join(home, 'director', 'transcript.jsonl'), 'utf8')).toContain('check out more than one branch')
})

test("the Director's replies should come from the chosen companion", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const settingsFile = join(home, 'app-settings.json')
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), companion: 'nori' }))
  await openChat(page)

  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-placeholder', 'Message Nori')
  await send(page, QUESTION)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply', { exact: true })).toContainText('check out more than one branch')
  // The greeting is headed "Nori, your director"; the reply carries the name alone.
  await expect(transcript.getByText('Nori', { exact: true })).toBeVisible()
})

test('asking for work should create a worktree and show the task in chat', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await openChat(page)

  await send(page, ONE_PROJECT_WORK)

  const group = page.getByRole('group', { name: 'Tasks' })
  const line = group.getByRole('listitem', { name: 'web · Add CONTRIBUTING.md' })
  await expect(line).toBeVisible()
  await expect(line.locator('[data-status]')).toHaveText(/Running|Idle/)
  await expect(page.getByLabel('Reply', { exact: true })).toContainText("I've started a task in @web")

  const [task] = storedTasks(home)
  expect(task).toMatchObject({ project: 'web', title: 'Add CONTRIBUTING.md', branch: `busyboy/${task.id}` })
  expect(task.worktree).toBe(join(home, 'task-worktrees', 'web', task.id))
  expect(git(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(task.branch)
  expect(git(task.worktree, 'rev-parse', 'HEAD')).toBe(git(projects.web, 'rev-parse', 'HEAD'))
  // The task agent got the request and answered from the task-agents script.
  await expect(line.locator('[data-status]')).toHaveText('Idle')
})

test('asking for work in two projects should create two tasks', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  await openChat(page)

  await send(page, TWO_PROJECT_WORK)

  const group = page.getByRole('group', { name: 'Tasks' })
  await expect(group).toHaveCount(1)
  await expect(group.getByRole('listitem')).toHaveCount(2)
  await expect(group.getByRole('listitem', { name: 'api · Add /health endpoint' })).toBeVisible()
  await expect(group.getByRole('listitem', { name: 'web · Show API health in footer' })).toBeVisible()
  await expect(page.getByLabel('Reply', { exact: true })).toContainText('I started two tasks')

  const tasks = storedTasks(home)
  expect(tasks.map(({ project }) => project).sort()).toEqual(['api', 'web'])
  for (const task of tasks) expect(git(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(task.branch)
})

test('typing @ should list projects', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web', 'api', 'docs'])
  await openChat(page)
  const message = page.getByRole('textbox', { name: 'Message' })

  await message.pressSequentially('Fix the build in @')

  const picker = page.getByRole('listbox', { name: 'Choose a project' })
  await expect(picker.getByRole('option')).toHaveText(['@web', '@api', '@docs'])
  await expect(picker.getByRole('option', { selected: true })).toHaveText('@web')

  await message.pressSequentially('d')
  await expect(picker.getByRole('option')).toHaveText(['@docs'])
  await message.press('Backspace')
  await message.press('ArrowDown')
  await expect(picker.getByRole('option', { selected: true })).toHaveText('@api')
  await message.press('Enter')

  await expect(picker).toBeHidden()
  await expect.poll(() => message.innerText()).toBe('Fix the build in @api ')

  await message.pressSequentially('and @')
  await expect(picker).toBeVisible()
  await message.press('Escape')
  await expect(picker).toBeHidden()
  await expect.poll(() => message.innerText()).toBe('Fix the build in @api and @')
})

test('a message sent while the Director is answering should interrupt it', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, SLOW_REQUEST)
  await expect(transcript.getByLabel('Reply in progress')).toContainText('Once upon a time, a lighthouse')

  await send(page, INTERRUPTING_REQUEST)

  const replies = transcript.getByLabel('Reply', { exact: true })
  await expect(replies.last()).toHaveText('Hi!')
  await expect(replies).toHaveCount(2)
  await expect(replies.first()).toHaveAttribute('data-interrupted', 'true')
  await expect(transcript.getByText('Interrupted', { exact: true })).toBeVisible()
  await expect(transcript.getByText('The end of the lighthouse story.')).toHaveCount(0)
  await expect(transcript).toHaveAttribute('data-status', 'idle')
  // The interrupted turn left nothing waiting, and no error was shown.
  await expect(transcript.getByRole('note')).toHaveCount(0)
  await expect(transcript.getByRole('alert')).toHaveCount(0)
  expect(readFileSync(join(home, 'director', 'transcript.jsonl'), 'utf8')).toContain('"interrupted":true')
})

test('two quick messages should reach the Director as one turn', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, 'First part.')
  await send(page, 'Second part.')

  await expect(transcript.getByLabel('Your message')).toHaveText(['First part.', 'Second part.'])
  // The script only has a turn for the joined text, so one reply means one turn.
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Got both parts in one message.')
  await expect(transcript.getByRole('note')).toHaveCount(0)
  await expect(transcript.getByRole('alert')).toHaveCount(0)
})

test('a question tool call from the Director should not leave it waiting', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web', 'api'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, AMBIGUOUS_REQUEST)

  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Which project has the login page, web or api?')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('a reply with text blocks around a tool call should keep every block apart', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, MULTI_BLOCK_REQUEST)

  await expect(transcript).toHaveAttribute('data-status', 'idle')
  await expect(transcript.getByLabel('Reply', { exact: true }).locator('p')).toHaveText([
    "I'll look at @web.",
    'It has a README and a src folder.',
    'Want a task for it?',
  ])
  expect(readFileSync(join(home, 'director', 'transcript.jsonl'), 'utf8')).toContain(
    "I'll look at @web.\\n\\nIt has a README and a src folder.\\n\\nWant a task for it?",
  )
})

test('a message sent while signed out should say no provider is signed in', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out', codex: 'signed-out' })
  // An earlier conversation must not make the Director use a provider the user signed out of.
  mkdirSync(join(home, 'director'))
  writeFileSync(join(home, 'director', 'state.json'), JSON.stringify({ provider: 'claude', sessionId: 'earlier-session' }))
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, QUESTION)

  await expect(transcript.getByLabel('Your message')).toHaveText(QUESTION)
  await expect(transcript.getByRole('alert')).toHaveText('No provider is signed in. Open Setup to sign in.')
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveCount(0)
})

test('a lost provider session should start a new conversation and still answer', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  // A session the provider no longer has: the scripted provider fails to resume `missing-` ids.
  mkdirSync(join(home, 'director'))
  writeFileSync(join(home, 'director', 'state.json'), JSON.stringify({ provider: 'claude', sessionId: 'missing-old-session' }))
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, QUESTION)

  await expect(transcript.getByRole('note')).toHaveText('The previous conversation could not be resumed. Started a new one.')
  await expect(transcript.getByLabel('Reply', { exact: true })).toContainText('check out more than one branch')
  const state = JSON.parse(readFileSync(join(home, 'director', 'state.json'), 'utf8')) as { sessionId: string }
  expect(state.sessionId).toMatch(/^scripted-/)
})

test('a long chat should compact while idle', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, LONG_REQUEST)
  const reply = transcript.getByLabel('Reply', { exact: true })
  await expect(reply.getByRole('listitem')).toHaveCount(12)
  // Nothing compacts while the reply is fresh; it happens once the user has been idle.
  await expect(transcript.getByRole('note')).toHaveCount(0)
  await expect(transcript.getByRole('alert')).toHaveCount(0)

  await expect(transcript.getByRole('note')).toHaveText('Context compacted', { timeout: 10_000 })
  await expect(transcript).toHaveAttribute('data-status', 'idle')

  // The display transcript does not depend on the compacted provider session.
  await page.reload()
  await expect(transcript.getByLabel('Your message')).toHaveText(LONG_REQUEST)
  await expect(reply.getByRole('listitem')).toHaveCount(12)
  await expect(transcript.getByRole('note')).toHaveText('Context compacted')
})
