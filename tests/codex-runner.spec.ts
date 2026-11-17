import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type Page } from '@playwright/test'
import { fakeCodexPidFile } from './fake-codex/fake-codex'
import { useProjectsHome } from './support/projects-home'

const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const APPROVAL_PROMPT = 'Run the shell command `touch notes.txt`, then reply with exactly: Created notes.txt.'
const QUESTION_PROMPT =
  'Ask me one question: which color I prefer, with exactly two options, Red and Blue. Then reply with exactly: You picked <the color>.'
const MCP_FORM_PROMPT = 'File a ticket with the tickets MCP server.'
const MCP_DEFAULTS_FORM_PROMPT = 'Clean up old tickets with the tickets MCP server.'
const USAGE_LIMIT_PROMPT = 'Reply with anything.'
const SLOW_REQUEST = 'Write a long story about a lighthouse.'
const INTERRUPTING_REQUEST = 'Never mind, just say hi.'
// Makes the fake `codex` start child processes and ignore SIGTERM.
const START_CHILDREN_PROMPT = 'Start a command that keeps running.'

const expect = baseExpect.configure({ timeout: 15_000 })

function isRunning(pid: number) {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function sendToCodexDirector(page: Page, text: string) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await send(page, text)
}

let home: string

test.beforeEach(async ({ context, baseURL }) => {
  ;({ home } = await useProjectsHome(context, baseURL!, [], { claude: 'signed-out' }))
})

test('sending a message to a Codex Director should show the scripted reply', async ({ page }) => {
  await sendToCodexDirector(page, PLAIN_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Your message')).toHaveText(PLAIN_PROMPT)
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('an approval request from a Codex Director should be denied and end the turn', async ({ page }) => {
  await sendToCodexDirector(page, APPROVAL_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByText('The command was denied, so Codex ended the turn.', { exact: true })).toBeVisible()
  await expect(transcript.getByText('Interrupted', { exact: true })).toHaveCount(0)
  await expect(transcript).toHaveAttribute('data-status', 'idle')
  await expect(transcript.getByLabel('Reply', { exact: true })).not.toContainText('Created notes.txt.')
})

test('a question from a Codex Director should be answered so the run continues', async ({ page }) => {
  await sendToCodexDirector(page, QUESTION_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  const reply = transcript.getByLabel('Reply', { exact: true })
  await expect(reply).toHaveCount(1)
  await expect(reply.locator('p').last()).toHaveText('You picked Blue.')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('an MCP form for a Codex Director should be declined at once', async ({ page }) => {
  await sendToCodexDirector(page, MCP_FORM_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Reply decline: null')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('an MCP form with only defaulted fields sent to a Codex Director should be declined', async ({ page }) => {
  await sendToCodexDirector(page, MCP_DEFAULTS_FORM_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Reply decline: null')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('a Codex turn that hits the usage limit should show a readable error', async ({ page }) => {
  await sendToCodexDirector(page, USAGE_LIMIT_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(
    transcript.getByText("Codex hit its usage limit. Codex said: You've hit your usage limit. Try again at 3:00 PM.", { exact: true }),
  ).toBeVisible()
  await expect(transcript).toHaveAttribute('data-status', 'idle')

  await send(page, PLAIN_PROMPT)
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
})

test('a message sent while a Codex Director is answering should wait, and Send now should interrupt it', async ({ page }) => {
  await sendToCodexDirector(page, SLOW_REQUEST)
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply in progress')).toContainText('Once upon a time, a lighthouse')

  await send(page, INTERRUPTING_REQUEST)

  const queued = page.getByRole('status', { name: 'Queued message' })
  await expect(queued).toContainText(INTERRUPTING_REQUEST)
  await expect(transcript.getByLabel('Reply in progress')).toContainText('Once upon a time, a lighthouse')
  await queued.getByRole('button', { name: 'Send now' }).click()

  const replies = transcript.getByLabel('Reply', { exact: true })
  await expect(replies.last()).toHaveText('Hi!')
  await expect(replies.first()).toHaveAttribute('data-interrupted', 'true')
  await expect(transcript.getByText('The end of the lighthouse story.')).toHaveCount(0)
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('stopping a Codex Director that ignores SIGTERM should still end the processes it started', async ({ page }) => {
  test.skip(process.platform === 'win32', 'The fake Codex child processes use POSIX process groups.')
  rmSync(fakeCodexPidFile, { force: true })
  await sendToCodexDirector(page, START_CHILDREN_PROMPT)

  await expect.poll(() => existsSync(fakeCodexPidFile)).toBe(true)
  const children = readFileSync(fakeCodexPidFile, 'utf8').trim().split(' ').map(Number)
  expect(children).toHaveLength(2)
  expect(children.every(isRunning)).toBe(true)

  await page.getByRole('button', { name: 'Stop' }).click()

  // SIGTERM is ignored, so the stop waits for the forced kill after the grace period.
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript).toHaveAttribute('data-status', 'idle', { timeout: 15_000 })
  await expect.poll(() => children.filter(isRunning), { timeout: 15_000 }).toEqual([])
})

test('a lost Codex thread should start a new conversation and still answer', async ({ page }) => {
  mkdirSync(join(home, 'director'))
  writeFileSync(join(home, 'director', 'state.json'), JSON.stringify({ provider: 'codex', sessionId: 'missing-old-thread' }))

  await sendToCodexDirector(page, PLAIN_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByRole('note')).toHaveText('The previous conversation could not be resumed. Started a new one.')
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
  const state = JSON.parse(readFileSync(join(home, 'director', 'state.json'), 'utf8')) as { sessionId: string }
  expect(state.sessionId).not.toBe('missing-old-thread')
})
