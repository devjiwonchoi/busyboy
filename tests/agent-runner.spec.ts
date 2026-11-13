import { expect, test, type Page } from '@playwright/test'

// Prompts recorded from real Claude runs in tests/provider-scripts/.
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const APPROVAL_PROMPT = 'Run the shell command `touch notes.txt` with the Bash tool, then reply with exactly: Created notes.txt.'
const QUESTION_PROMPT =
  'Use the AskUserQuestion tool to ask me one question: which color I prefer, with exactly two options, Red and Blue. Then reply with exactly: You picked <the color>.'

async function sendMessage(page: Page, text: string) {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('sending a message should show the scripted reply', async ({ page }) => {
  await sendMessage(page, PLAIN_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByText(PLAIN_PROMPT)).toBeVisible()
  await expect(transcript.getByText('Hello from busyboy.', { exact: true })).toBeVisible()
})

test('stopping an agent should end its stream', async ({ page }) => {
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

test('answering a scripted approval should let the run continue', async ({ page }) => {
  await sendMessage(page, APPROVAL_PROMPT)

  const transcript = page.getByRole('log', { name: 'Transcript' })
  const approval = transcript.getByRole('group', { name: 'Approval request' })
  await expect(approval).toContainText('Allow Bash: touch notes.txt?')
  await expect(transcript.getByText('Created notes.txt.', { exact: true })).toBeHidden()

  await approval.getByRole('button', { name: 'Allow' }).click()

  await expect(transcript.getByText('Created notes.txt.', { exact: true })).toBeVisible()
  await expect(approval.getByRole('button', { name: 'Allow' })).toBeHidden()
})

test('choosing an option for a scripted question should let the run continue', async ({ page }) => {
  await sendMessage(page, QUESTION_PROMPT)

  const question = page.getByRole('group', { name: 'Question' })
  await expect(question).toContainText('Which color do you prefer?')

  await question.getByRole('button', { name: 'Blue' }).click()

  await expect(page.getByText('You picked Blue.', { exact: true })).toBeVisible()
  await expect(question.getByRole('button', { name: 'Blue' })).toBeHidden()
})
