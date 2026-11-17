import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

test('a reported context usage should show the meter', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await page.goto('/')
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript).toHaveAttribute('data-connected', 'true')
  await expect(page.getByRole('meter', { name: 'Context usage' })).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Message' }).fill('How full is the context?')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('The context is partly used.')
  const meter = page.getByRole('meter', { name: 'Context usage' })
  await expect(meter).toBeVisible()
  await expect(meter).toHaveAttribute('aria-valuenow', '60000')
  await expect(meter).toHaveAttribute('aria-valuemax', '200000')
  await expect(meter).toContainText('60k / 200k')
  await page.screenshot({ path: '/opt/cursor/artifacts/context-meter.png' })
})
