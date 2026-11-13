import { expect, test, type Page } from '@playwright/test'

// Prompts recorded from real Codex runs in tests/provider-scripts/codex/. The real Codex
// adapter plays them through tests/fake-codex.mjs.
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const APPROVAL_PROMPT = 'Run the shell command `touch notes.txt`, then reply with exactly: Created notes.txt.'
const QUESTION_PROMPT =
  'Ask me one question: which color I prefer, with exactly two options, Red and Blue. Then reply with exactly: You picked <the color>.'

async function sendMessage(page: Page, text: string) {
  await page.goto('/?provider=codex')
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('sending a message to Codex should show the scripted reply', async ({ page }) => {
  await sendMessage(page, PLAIN_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByText(PLAIN_PROMPT)).toBeVisible()
  await expect(transcript.getByText('Hello from busyboy.', { exact: true })).toBeVisible()
})

test('stopping a Codex agent should end its stream', async ({ page }) => {
  await sendMessage(page, APPROVAL_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  const approval = transcript.getByRole('group', { name: 'Approval request' })
  await expect(approval.getByRole('button', { name: 'Allow' })).toBeVisible()
  await expect(transcript).toHaveAttribute('data-stream', 'open')

  await page.getByRole('button', { name: 'Stop' }).click()

  await expect(transcript.getByRole('status')).toHaveText('Agent stopped before finishing.')
  await expect(transcript).toHaveAttribute('data-stream', 'closed')
  await expect(approval.getByRole('button', { name: 'Allow' })).toBeHidden()
  await expect(transcript.getByText('Created notes.txt.', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
})

test('answering a scripted Codex approval should let the run continue', async ({ page }) => {
  await sendMessage(page, APPROVAL_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByText('Shell: touch notes.txt', { exact: true })).toBeVisible()
  const approval = transcript.getByRole('group', { name: 'Approval request' })
  await expect(approval).toContainText('Allow Shell: touch notes.txt?')
  await expect(transcript.getByText('Created notes.txt.', { exact: true })).toBeHidden()

  await approval.getByRole('button', { name: 'Allow' }).click()

  await expect(transcript.getByText('Created notes.txt.', { exact: true })).toBeVisible()
  await expect(approval.getByRole('button', { name: 'Allow' })).toBeHidden()
})

test('choosing an option for a scripted Codex question should let the run continue', async ({ page }) => {
  await sendMessage(page, QUESTION_PROMPT)

  const question = page.getByRole('group', { name: 'Question' })
  await expect(question).toContainText('Which color do you prefer?')

  await question.getByRole('button', { name: 'Blue' }).click()

  await expect(page.getByText('You picked Blue.', { exact: true })).toBeVisible()
  await expect(question.getByRole('button', { name: 'Blue' })).toBeHidden()
})

test('interrupting a Codex turn should still run the message queued behind it', async ({ page }) => {
  // Codex waits inside this turn for the answer, so only an interrupt request can end it.
  await sendMessage(page, QUESTION_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  const question = transcript.getByRole('group', { name: 'Question' })
  await expect(question.getByRole('button', { name: 'Blue' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message' }).fill(PLAIN_PROMPT)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByText(PLAIN_PROMPT)).toBeVisible()

  await page.getByRole('button', { name: 'Interrupt' }).click()

  await expect(question.getByRole('button', { name: 'Blue' })).toBeHidden()
  await expect(transcript.getByText('Hello from busyboy.', { exact: true })).toBeVisible()
  await expect(transcript.getByText(/^You picked/)).toBeHidden()
})
