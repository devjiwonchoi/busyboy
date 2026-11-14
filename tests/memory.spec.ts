import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Hand-written scripts in tests/provider-scripts/memory.json. "Show me your prompt."
// makes the Director reply with its own system prompt, and the task request "Set up
// the package manager." makes the task agent write its prompt to PROMPT_FILE in its
// worktree, so these journeys see what memory reached each.
const REMEMBER = 'Remember that I prefer pnpm over npm.'
const WORK = 'In @web, set up the package manager.'
const SHOW_PROMPT = 'Show me your prompt.'
const PROMPT_FILE = 'busyboy-prompt.txt'

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

/** Waits until the Director finished answering `count` messages in all. */
async function waitForReplies(page: Page, count: number) {
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveCount(count)
  await expect(transcript).toHaveAttribute('data-status', 'idle')
}

async function openMemoryTab(page: Page) {
  await page.getByRole('tab', { name: 'Memory' }).click()
  const memory = page.getByRole('region', { name: 'Memory', exact: true })
  await expect(memory).toHaveAttribute('data-loaded', 'true')
  return memory
}

/** Writes a global fact the way busyboy stores it. */
function seedFact(home: string, id: string, title: string, text: string) {
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', `${id}.md`), `# ${title}\n\n${text}\n`)
}

test('telling the director to remember a preference should save it', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const memory = await openMemoryTab(page)
  await expect(memory).toContainText('Nothing remembered yet')

  await send(page, REMEMBER)

  await waitForReplies(page, 1)
  const fact = memory.getByRole('listitem', { name: 'Prefers pnpm' })
  await expect(fact).toContainText('The user prefers pnpm over npm.')
  await expect(memory.getByRole('region', { name: 'Global memory' })).toContainText('Prefers pnpm')
  expect(readFileSync(join(home, 'memory', 'prefers-pnpm.md'), 'utf8')).toBe('# Prefers pnpm\n\nThe user prefers pnpm over npm.\n')
  expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf8')).toContain('[Prefers pnpm](prefers-pnpm.md)')
})

test('a saved preference should reach the next task', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  await send(page, REMEMBER)
  await waitForReplies(page, 1)

  await send(page, WORK)

  await waitForReplies(page, 2)
  const line = page.getByRole('group', { name: 'Tasks' }).getByRole('listitem', { name: 'web · Set up package manager' })
  await expect(line).toBeVisible()
  const [task] = (JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { worktree: string }[] }).tasks
  const promptFile = join(task.worktree, PROMPT_FILE)
  // Poll the content, not the file: it exists, empty, before it is written.
  const readPrompt = () => (existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '')
  await expect.poll(readPrompt).toContain('# Memory')
  const prompt = readPrompt()
  // Instructions first, then memory: the order that keeps the prompt cache.
  expect(prompt).toContain('You are a busyboy task agent for the project "web".')
  expect(prompt).toContain('### Prefers pnpm\nThe user prefers pnpm over npm.')
  expect(prompt.indexOf('# Memory')).toBeGreaterThan(prompt.indexOf('You are a busyboy task agent'))
})

test('editing a memory should change the file', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  seedFact(home, 'prefers-pnpm', 'Prefers pnpm', 'The user prefers pnpm over npm.')
  await openChat(page)
  const memory = await openMemoryTab(page)

  await memory.getByRole('button', { name: 'Edit Prefers pnpm' }).click()
  const editor = memory.getByRole('listitem', { name: 'Editing Prefers pnpm' })
  await editor.getByRole('textbox', { name: 'Title' }).fill('Package manager')
  await editor.getByRole('textbox', { name: 'Text' }).fill('Use pnpm. Never run npm install.')
  await editor.getByRole('button', { name: 'Save' }).click()

  await expect(memory.getByRole('listitem', { name: 'Package manager' })).toContainText('Use pnpm. Never run npm install.')
  // The id stays, so the same file changes and no second fact appears.
  expect(readFileSync(join(home, 'memory', 'prefers-pnpm.md'), 'utf8')).toBe('# Package manager\n\nUse pnpm. Never run npm install.\n')
  expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf8')).toContain('[Package manager](prefers-pnpm.md)')
  await expect(memory.getByRole('listitem')).toHaveCount(1)
})

test('forgetting a memory should remove it from the next prompt', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  seedFact(home, 'prefers-pnpm', 'Prefers pnpm', 'The user prefers pnpm over npm.')
  await openChat(page)
  const replies = page.getByRole('log', { name: 'Transcript' }).getByLabel('Reply', { exact: true })
  await send(page, SHOW_PROMPT)
  await waitForReplies(page, 1)
  await expect(replies.nth(0)).toContainText('The user prefers pnpm over npm.')

  const memory = await openMemoryTab(page)
  await memory.getByRole('button', { name: 'Delete Prefers pnpm' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect(memory).toContainText('Nothing remembered yet')
  expect(existsSync(join(home, 'memory', 'prefers-pnpm.md'))).toBe(false)

  await send(page, SHOW_PROMPT)

  await waitForReplies(page, 2)
  await expect(replies.nth(1)).toContainText('Nothing is saved yet.')
  await expect(replies.nth(1)).not.toContainText('prefers pnpm')
})
