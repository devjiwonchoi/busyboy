import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const QUESTION = 'What does git worktree do? Answer in one sentence.'

async function openChat(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('hovering a message should copy it and show when it was sent', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openChat(page)

  await page.getByRole('textbox', { name: 'Message' }).fill(QUESTION)
  await page.getByRole('button', { name: 'Send' }).click()

  const transcript = page.getByRole('log', { name: 'Transcript' })
  const user = transcript.getByLabel('Your message')
  const reply = transcript.getByLabel('Reply', { exact: true })
  await expect(reply).toContainText('check out more than one branch')
  await expect(transcript).toHaveAttribute('data-status', 'idle')

  const stored = readFileSync(join(home, 'director', 'transcript.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { kind: string; at: string; text?: string })
  const userEntry = stored.find((entry) => entry.kind === 'user')
  const replyEntry = stored.find((entry) => entry.kind === 'director')
  expect(userEntry?.at).toBeTruthy()
  expect(replyEntry?.text).toBeTruthy()

  const userToolbar = user.locator('..').getByRole('toolbar', { name: 'Message actions' })
  const replyToolbar = reply.locator('..').getByRole('toolbar', { name: 'Message actions' })
  await expect(userToolbar).toHaveCSS('opacity', '0')
  await expect(user.locator('..').locator('time')).toHaveAttribute('datetime', userEntry!.at)
  await expect(reply.locator('..').locator('time')).toHaveAttribute('datetime', replyEntry!.at)

  // The time and actions sit under each bubble, not on a row above it.
  for (const [bubble, toolbar] of [
    [user, userToolbar],
    [reply, replyToolbar],
  ] as const) {
    const bubbleBox = await bubble.boundingBox()
    const toolbarBox = await toolbar.boundingBox()
    expect(bubbleBox && toolbarBox).toBeTruthy()
    expect(toolbarBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height - 1)
  }
  const header = reply.locator('..').locator('[data-slot="message-header"]')
  const headerBox = await header.boundingBox()
  const replyBox = await reply.boundingBox()
  expect(headerBox && replyBox).toBeTruthy()
  expect(replyBox!.y - (headerBox!.y + headerBox!.height)).toBeLessThanOrEqual(12)

  await user.hover()
  await expect(userToolbar).toHaveCSS('opacity', '1')
  await userToolbar.getByRole('button', { name: 'Copy' }).click()
  await expect(userToolbar.getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(QUESTION)

  await reply.hover()
  await expect(replyToolbar).toHaveCSS('opacity', '1')
  await expect(replyToolbar.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await replyToolbar.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(replyEntry!.text)
})
