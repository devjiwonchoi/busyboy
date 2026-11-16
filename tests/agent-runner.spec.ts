import { existsSync, readFileSync, rmSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { fakeClaudePidFile, fakeClaudeURL } from './fake-claude/fake-claude'
import { useProjectsHome } from './support/projects-home'

// The agent runner, driven through the Director's chat: the Director is the
// one agent the user talks to directly. Prompts are recorded from real Claude
// runs in tests/provider-scripts/ (the slow story is hand-written).
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const APPROVAL_PROMPT = 'Run the shell command `touch notes.txt` with the Bash tool, then reply with exactly: Created notes.txt.'
const QUESTION_PROMPT =
  'Use the AskUserQuestion tool to ask me one question: which color I prefer, with exactly two options, Red and Blue. Then reply with exactly: You picked <the color>.'
const SLOW_REQUEST = 'Write a long story about a lighthouse.'

function isRunning(pid: number) {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function sendMessage(page: Page, text: string) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('sending a message should show the scripted reply', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [])
  await sendMessage(page, PLAIN_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Your message')).toHaveText(PLAIN_PROMPT)
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
})

test('stopping the Director should end its reply, and the next message should continue', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [])
  await sendMessage(page, SLOW_REQUEST)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply in progress')).toContainText('Once upon a time, a lighthouse')
  await page.getByRole('button', { name: 'Stop' }).click()

  await expect(transcript.getByLabel('Reply', { exact: true })).toContainText('Once upon a time, a lighthouse')
  await expect(transcript.getByText('Interrupted', { exact: true })).toBeVisible()
  await expect(transcript).toHaveAttribute('data-status', 'idle')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden()
  await expect(transcript.getByText('The end of the lighthouse story.')).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Message' }).fill(PLAIN_PROMPT)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true }).last()).toHaveText('Hello from busyboy.')
})

test('an approval request from the Director should be denied so the run continues', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [])
  await sendMessage(page, APPROVAL_PROMPT)

  // The recorded run has a branch for a denial (tests/provider-scripts/claude-approval.json).
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('I was not allowed to create notes.txt.')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('a question tool call from the Director should be answered with a request to ask in text', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [])
  await sendMessage(page, QUESTION_PROMPT)

  // The recorded run has a branch for that answer (tests/provider-scripts/claude-question.json).
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Which color do you prefer, Red or Blue?')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test.describe('with the real Claude adapter', () => {
  test.use({ baseURL: fakeClaudeURL })

  test('stopping the Director should end the processes it started', async ({ page, context }) => {
    rmSync(fakeClaudePidFile, { force: true })
    // The fake CLI never answers a sign-in check, so the journey reports Claude as signed in.
    await useProjectsHome(context, fakeClaudeURL, [], { claude: 'signed-in' })
    await sendMessage(page, 'Start working.')

    // The fake CLI has started its children once it records their pids.
    await expect.poll(() => existsSync(fakeClaudePidFile)).toBe(true)
    const children = readFileSync(fakeClaudePidFile, 'utf8').trim().split(' ').map(Number)
    expect(children).toHaveLength(2)
    expect(children.every(isRunning)).toBe(true)

    await page.getByRole('button', { name: 'Stop' }).click()

    const transcript = page.getByRole('log', { name: 'Transcript' })
    await expect(transcript.getByRole('note')).toHaveText('Stopped.')
    await expect.poll(() => children.filter(isRunning)).toEqual([])
  })
})
