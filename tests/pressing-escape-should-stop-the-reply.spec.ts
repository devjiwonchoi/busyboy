import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const SLOW_REQUEST = 'Write a long story about a lighthouse.'

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('pressing Escape should stop the Director reply', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })

  await page.getByRole('textbox', { name: 'Message' }).fill(SLOW_REQUEST)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply in progress')).toContainText('Once upon a time, a lighthouse')

  await page.getByRole('textbox', { name: 'Message' }).press('Escape')

  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveAttribute('data-interrupted', 'true')
  await expect(transcript.getByText('The end of the lighthouse story.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden()
  await expect(transcript).toHaveAttribute('data-status', 'idle')
})
