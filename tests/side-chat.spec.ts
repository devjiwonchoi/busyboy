import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Hand-written script: tests/provider-scripts/side-chat.json. Its side turns
// play only in a session whose history holds the main chat's message, so an
// answer proves the side agent branched from the Director's session.
const MAIN_MESSAGE = "Let's call the next release Bluebird."
const SIDE_QUESTION = 'What is the next release called?'
const SECOND_SIDE_QUESTION = 'Who picked the name?'
const SLOW_SIDE_QUESTION = 'Spell the release name slowly.'
const MAIN_FOLLOW_UP = 'What was my last question?'
const SIDE_FOLLOW_UP = 'What did I just ask you?'

async function startMainChat(page: Page) {
  await page.goto('/')
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript).toHaveAttribute('data-connected', 'true')
  await page.getByRole('textbox', { name: 'Message' }).fill(MAIN_MESSAGE)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Noted: the next release is Bluebird.')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
  return transcript
}

/** Asks in the open side chat tab and returns the side agent's event stream URL. */
async function askSide(page: Page, question: string) {
  await page.getByRole('tab', { name: 'Side chat', exact: true }).click()
  const stream = page.waitForRequest(/\/api\/side-chat\/[^/]+\/events/)
  await page.getByRole('textbox', { name: 'Side question' }).fill(question)
  await page.getByRole('button', { name: 'Ask' }).click()
  return (await stream).url()
}

/** The agent's events once it has stopped; the route ends the stream only then. */
async function eventsAfterStop(page: Page, url: string) {
  const response = await page.request.get(url, { timeout: 10_000 })
  return response.text()
}

test('asking in side chat should not add to the main chat', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const transcript = await startMainChat(page)
  const transcriptFile = join(home, 'director', 'transcript.jsonl')
  const stateFile = join(home, 'director', 'state.json')
  const savedTranscript = readFileSync(transcriptFile, 'utf8')
  const savedState = readFileSync(stateFile, 'utf8')

  await askSide(page, SIDE_QUESTION)

  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Your side question')).toHaveText(SIDE_QUESTION)
  await expect(side.getByLabel('Side answer')).toHaveText('It is called Bluebird.')
  // Neither the screen, the stored transcript, nor the Director's session changed.
  await expect(transcript.getByLabel('Your message')).toHaveCount(1)
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveCount(1)
  expect(readFileSync(transcriptFile, 'utf8')).toBe(savedTranscript)
  expect(readFileSync(stateFile, 'utf8')).toBe(savedState)

  // The Director's provider session never saw the side question either.
  await page.getByRole('textbox', { name: 'Message' }).fill(MAIN_FOLLOW_UP)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true }).nth(1)).toHaveText('You asked to call the next release Bluebird.')

  await page.reload()
  await expect(page.getByRole('log', { name: 'Transcript' })).not.toContainText(SIDE_QUESTION)
})

test('a side answer should know what the main chat discussed', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const settingsFile = join(home, 'app-settings.json')
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), companion: 'nori' }))
  await startMainChat(page)

  const agent = await askSide(page, SIDE_QUESTION)

  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('It is called Bluebird.')
  // The same companion answers as in the main chat.
  await expect(side.getByText('Nori', { exact: true })).toBeVisible()
  // The tab is named after its first question.
  await expect(page.getByRole('tab', { name: SIDE_QUESTION })).toBeVisible()
  expect(agent).toMatch(/\/api\/side-chat\/[^/]+\/events/)
})

test('a follow-up in a side chat should continue its conversation', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await startMainChat(page)
  const first = await askSide(page, SIDE_QUESTION)
  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('It is called Bluebird.')

  const second = await askSide(page, SIDE_FOLLOW_UP)

  // The same side agent answers, from after the first answer.
  expect(new URL(second).pathname).toBe(new URL(first).pathname)
  await expect(side.getByLabel('Side answer').nth(1)).toHaveText('You asked what the next release is called.')
  await expect(side.getByLabel('Side answer')).toHaveCount(2)
})

test('opening another side chat should keep both conversations', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await startMainChat(page)
  await askSide(page, SIDE_QUESTION)
  await expect(page.getByRole('log', { name: 'Side chat' }).getByLabel('Side answer')).toHaveText('It is called Bluebird.')

  await page.getByRole('button', { name: 'New side chat' }).click()
  await askSide(page, SECOND_SIDE_QUESTION)

  // Each tab's panel holds its own conversation; panels are named by their tab.
  const second = page.getByRole('tabpanel', { name: SECOND_SIDE_QUESTION })
  await expect(second.getByLabel('Side answer')).toHaveText('You did, in the main chat.')
  await page.getByRole('tab', { name: SIDE_QUESTION }).click()
  const first = page.getByRole('tabpanel', { name: SIDE_QUESTION })
  await expect(first.getByLabel('Side answer')).toHaveText('It is called Bluebird.')
  await expect(first.getByLabel('Your side question')).toHaveCount(1)
})

test('asking a side question before the main chat has started should say so', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')

  await page.getByRole('tab', { name: 'Side chat' }).click()
  await page.getByRole('textbox', { name: 'Side question' }).fill(SIDE_QUESTION)
  await page.getByRole('button', { name: 'Ask' }).click()

  await expect(page.getByRole('log', { name: 'Side chat' })).toContainText('Start a conversation in the main chat first.')
})

test('stopping a side answer should end its agent', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await startMainChat(page)
  const side = page.getByRole('log', { name: 'Side chat' })
  const agent = await askSide(page, SLOW_SIDE_QUESTION)
  await expect(side.getByLabel('Side answer')).toHaveText('B-l-u-e')

  // The main chat is idle, so the only Stop button is the side chat's.
  await page.getByRole('button', { name: 'Stop' }).click()

  await expect(side.getByRole('note')).toHaveText('Stopped.')
  expect(await eventsAfterStop(page, agent)).toContain('"type":"stopped"')
})

test('closing side chat should end its agent', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await startMainChat(page)
  const agent = await askSide(page, SLOW_SIDE_QUESTION)
  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('B-l-u-e')

  await page.getByRole('button', { name: `Close ${SLOW_SIDE_QUESTION}` }).click()

  await expect(page.getByRole('tab', { name: SLOW_SIDE_QUESTION })).toHaveCount(0)
  await expect(side.getByLabel('Side answer')).toHaveCount(0)
  expect(await eventsAfterStop(page, agent)).toContain('"type":"stopped"')
})

test('returning from setup should show the side answer once', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await startMainChat(page)
  await askSide(page, SIDE_QUESTION)
  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('It is called Bluebird.')

  // Next hides the main screen instead of unmounting it, so the side chat keeps its answer.
  await page.getByRole('link', { name: 'Setup' }).click()
  await expect(page.getByRole('main', { name: 'Setup' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to chat' }).click()

  await expect(side.getByLabel('Side answer')).toHaveText('It is called Bluebird.')
  await expect(side.getByLabel('Your side question')).toHaveCount(1)
})

test('returning from setup while an answer streams should show it once', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await startMainChat(page)
  await askSide(page, SLOW_SIDE_QUESTION)
  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('B-l-u-e')

  await page.getByRole('link', { name: 'Setup' }).click()
  await expect(page.getByRole('main', { name: 'Setup' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to chat' }).click()

  // The stream starts over from the question, so the text is replaced, not added again.
  await expect(side.getByLabel('Side answer')).toHaveText('B-l-u-e')
})
