import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type Page } from '@playwright/test'
import { fakeGrokURL } from './fake-grok/fake-grok'
import { useProjectsHome } from './support/projects-home'

// The real Grok adapter on the fake ACP process. The chat picker offers Grok
// only while Grok is signed in, and a chat that chooses it keeps that choice.
const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const expect = baseExpect.configure({ timeout: 15_000 })

test.use({ baseURL: fakeGrokURL })

const harnessFile = (home: string) => join(home, 'director', 'harness.json')
const launchFile = (home: string) => join(home, 'director', '.grok-launch.json')

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function optionValues(page: Page) {
  return page
    .getByRole('group', { name: 'Harness' })
    .getByLabel('Harness', { exact: true })
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
}

test('choosing Grok for a chat should keep Grok and answer through it', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, [], { claude: 'signed-in', grok: 'signed-in' })
  await openChat(page)
  const harness = page.getByRole('group', { name: 'Harness' })
  await expect.poll(() => optionValues(page)).toEqual(['claude', 'codex', 'grok'])

  await harness.getByLabel('Harness', { exact: true }).selectOption('grok')
  await harness.getByLabel('Model').fill('grok-4.5')
  await harness.getByLabel('Model').blur()
  await harness.getByLabel('Effort').selectOption('high')
  await expect.poll(() => JSON.parse(readFileSync(harnessFile(home), 'utf8'))).toEqual({
    provider: 'grok',
    model: 'grok-4.5',
    effort: 'high',
  })

  await page.reload()
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  const kept = page.getByRole('group', { name: 'Harness' })
  await expect(kept).toHaveAttribute('data-provider', 'grok')
  await expect(kept.getByLabel('Harness', { exact: true })).toHaveValue('grok')
  await expect(kept.getByLabel('Model')).toHaveValue('grok-4.5')
  await expect(kept.getByLabel('Effort')).toHaveValue('high')

  await page.getByRole('textbox', { name: 'Message' }).fill(PLAIN_PROMPT)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
  expect(JSON.parse(readFileSync(launchFile(home), 'utf8'))).toEqual({ model: 'grok-4.5', effort: 'high' })
  expect(JSON.parse(readFileSync(harnessFile(home), 'utf8')).provider).toBe('grok')
})

test('a signed-out Grok should not be offered in the harness picker', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [], { claude: 'signed-in', grok: 'signed-out' })
  await openChat(page)

  await expect.poll(() => optionValues(page)).toEqual(['claude', 'codex'])
})
