import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const QUESTION = 'What does git worktree do? Answer in one sentence.'

async function openChat(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('a Director reply should suggest next messages and clicking one should fill the composer', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })
  const box = page.getByRole('textbox', { name: 'Message' })

  await expect(page.getByRole('group', { name: 'Suggested replies' })).toHaveCount(0)
  await box.fill(QUESTION)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true })).toContainText('check out more than one branch')
  await expect(transcript).toHaveAttribute('data-status', 'idle')

  const suggestions = page.getByRole('group', { name: 'Suggested replies' })
  await expect(suggestions.getByRole('button')).toHaveText(['Tell me more', 'Make it shorter', 'What should I do next?'])
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await page.getByRole('region', { name: 'Chat' }).screenshot({ path: '/opt/cursor/artifacts/suggestion-chips.png' })

  await suggestions.getByRole('button', { name: 'Tell me more' }).click()
  await expect.poll(() => box.innerText()).toBe('Tell me more')
  await expect(suggestions).toHaveCount(0)
  await expect(transcript.getByLabel('Your message')).toHaveCount(1)
})
