import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const QUESTION = 'What does git worktree do? Answer in one sentence.'

async function openChat(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('a Director reply should not offer suggestion chips', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })
  const box = page.getByRole('textbox', { name: 'Message' })

  await expect(page.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0)
  await box.fill(QUESTION)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true })).toContainText('check out more than one branch')
  await expect(transcript).toHaveAttribute('data-status', 'idle')

  await expect(page.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Tell me more' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Make it shorter' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'What should I do next?' })).toHaveCount(0)
  await expect.poll(() => box.innerText()).toBe('')
})
