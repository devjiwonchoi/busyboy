import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const SLOW_REQUEST = 'Write a long story about a lighthouse.'
const MAIN_MESSAGE = "Let's call the next release Bluebird."
const SLOW_SIDE_QUESTION = 'Spell the release name slowly.'

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

test('pressing Escape should stop the side chat reply', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await page.getByRole('textbox', { name: 'Message' }).fill(MAIN_MESSAGE)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Noted: the next release is Bluebird.')

  await page.getByRole('tab', { name: 'Side chat', exact: true }).click()
  const stream = page.waitForRequest(/\/api\/side-chat\/[^/]+\/events/)
  await page.getByRole('textbox', { name: 'Side question' }).fill(SLOW_SIDE_QUESTION)
  await page.getByRole('button', { name: 'Ask' }).click()
  const agent = (await stream).url()

  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('B-l-u-e')
  await page.getByRole('textbox', { name: 'Side question' }).press('Escape')

  await expect(side.getByRole('note')).toHaveText('Stopped.')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden()
  const response = await page.request.get(agent, { timeout: 10_000 })
  expect(await response.text()).toContain('"type":"stopped"')
  await expect(transcript.getByLabel('Your message')).toHaveCount(1)
})
