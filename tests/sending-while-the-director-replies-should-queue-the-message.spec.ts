import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const SLOW_COUNT = 'Count to three slowly.'
const QUEUED = 'Now say done.'
const SLOW_STORY = 'Write a long story about a lighthouse.'
const DROPPED = 'Never mind, just say hi.'

async function openChat(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('sending while the Director replies should queue the message and send it after the turn', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, SLOW_COUNT)
  await expect(transcript.getByLabel('Reply in progress')).toContainText('One')

  await send(page, QUEUED)
  const queued = page.getByRole('status', { name: 'Queued message' })
  await expect(queued).toContainText('Send after this reply')
  await expect(queued).toContainText(QUEUED)
  await expect(transcript.getByLabel('Reply in progress')).toContainText('One')
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveCount(0)

  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await page.getByRole('region', { name: 'Chat' }).screenshot({ path: '/opt/cursor/artifacts/queued-message.png' })

  const replies = transcript.getByLabel('Reply', { exact: true })
  await expect(replies.first()).toHaveText('One, two, three.')
  await expect(replies.first()).not.toHaveAttribute('data-interrupted')
  await expect(replies.nth(1)).toHaveText('Done.')
  await expect(queued).toHaveCount(0)
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})

test('stopping the reply should clear the queued message', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await send(page, SLOW_STORY)
  await expect(transcript.getByLabel('Reply in progress')).toContainText('Once upon a time, a lighthouse')
  await send(page, DROPPED)

  const queued = page.getByRole('status', { name: 'Queued message' })
  await expect(queued).toContainText(DROPPED)
  await page.getByRole('button', { name: 'Stop' }).click()

  await expect(queued).toHaveCount(0)
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveAttribute('data-interrupted', 'true')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
  // The queued text was dropped, so its reply must not arrive after the turn ends.
  await page.waitForTimeout(1500)
  await expect(transcript.getByText('Hi!')).toHaveCount(0)
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})
