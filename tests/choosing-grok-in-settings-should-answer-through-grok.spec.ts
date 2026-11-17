import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect as baseExpect, test, type Page } from '@playwright/test'
import { fakeGrokURL } from './fake-grok/fake-grok'
import { useProjectsHome } from './support/projects-home'

const PLAIN_PROMPT = 'Reply with exactly this sentence and nothing else: Hello from busyboy.'
const expect = baseExpect.configure({ timeout: 15_000 })

test.use({ baseURL: fakeGrokURL })

const launchFile = (home: string) => join(home, 'director', '.grok-launch.json')

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('choosing Grok in Settings should answer through Grok on its own model', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, [], { claude: 'signed-in', grok: 'signed-in' })
  await page.goto('/settings?section=agents')
  const harness = page.getByRole('radiogroup', { name: 'Harness' })
  await expect(harness.getByRole('radio', { name: 'Use Grok by default' })).toBeEnabled()
  await expect(page.getByLabel('Model')).toHaveCount(0)
  await expect(page.getByLabel('Effort')).toHaveCount(0)

  await harness.getByRole('radio', { name: 'Use Grok by default' }).click()
  await expect.poll(() => JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')).defaultProvider).toBe('grok')
  await page.reload()
  await expect(page.getByRole('radiogroup', { name: 'Harness' }).getByRole('radio', { name: 'Use Grok by default' })).toBeChecked()

  await openChat(page)
  await expect(page.getByRole('radiogroup', { name: 'Harness' })).toHaveCount(0)
  await expect(page.getByLabel('Model')).toHaveCount(0)
  await expect(page.getByLabel('Effort')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message' }).fill(PLAIN_PROMPT)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByLabel('Reply', { exact: true })).toHaveText('Hello from busyboy.')
  expect(JSON.parse(readFileSync(launchFile(home), 'utf8'))).toEqual({ model: null, effort: null })
  expect(existsSync(join(home, 'director', 'harness.json'))).toBe(false)
  expect(JSON.parse(readFileSync(join(home, 'director', 'state.json'), 'utf8')).provider).toBe('grok')
})

test('a signed-out Grok should show as signed out in Settings', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [], { claude: 'signed-in', grok: 'signed-out' })
  await page.goto('/settings?section=agents')
  const harness = page.getByRole('radiogroup', { name: 'Harness' })
  const grok = harness.getByRole('radio', { name: 'Use Grok by default' })
  await expect(grok).toBeDisabled()
  await expect(harness.locator('label').filter({ hasText: 'Use Grok by default' })).toContainText('Signed out')

  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await expect(page.getByRole('radiogroup', { name: 'Harness' })).toHaveCount(0)
  await expect(page.getByLabel('Model')).toHaveCount(0)
  await expect(page.getByLabel('Effort')).toHaveCount(0)
})
