import { expect, test } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { startStandaloneServer } from './support/standalone-server'

// Agents coming back after the server restarts. Script: tests/provider-scripts/director-resume.json.
// Scripted sessions are saved under the temp folder like a provider's
// own session files, so a restarted server resumes them with their history.

test('restarting the server should continue the Director conversation', async ({ browser }) => {
  const server = await startStandaloneServer()
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    await useProjectsHome(context, server.baseURL, [])
    const page = await context.newPage()
    const send = async (text: string) => {
      await page.goto('/')
      await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
      await page.getByRole('textbox', { name: 'Message' }).fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
    }
    const replies = page.getByRole('log', { name: 'Transcript' }).getByLabel('Reply', { exact: true })
    await send('Remember the word lighthouse.')
    await expect(replies).toHaveText(['Noted.'])

    await server.stop('SIGKILL')
    await server.restart()
    await send('What word did I ask you to remember?')

    // Only the same provider session knows the word.
    await expect(replies).toHaveText(['Noted.', 'Lighthouse.'])
    await expect(page.getByRole('log', { name: 'Transcript' }).getByRole('note')).toHaveCount(0)
    await context.close()
  } finally {
    await server.dispose()
  }
})
