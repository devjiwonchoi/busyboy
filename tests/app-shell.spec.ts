import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`opening the app should show the shell, and the shortcut should toggle the panel (${colorScheme})`, async ({ page }) => {
    const policyViolations: string[] = []
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) policyViolations.push(message.text())
    })
    await page.emulateMedia({ colorScheme })
    await page.goto('/')

    await expect(page).toHaveTitle('BusyBoy')
    const chat = page.getByRole('region', { name: 'Chat' })
    const panel = page.getByRole('region', { name: 'Bottom panel' })

    await expect(chat).toContainText('BusyBoy is ready.')
    await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Toggle sidebar' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Projects' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Memory' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Side chat' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Week' })).toHaveCount(0)
    await expect(panel).toBeHidden()

    const appliedScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    expect(appliedScheme).toBe('dark')

    await page.keyboard.press('ControlOrMeta+j')
    await expect(panel).toBeVisible()
    await page.getByRole('button', { name: 'Toggle bottom panel' }).click()
    await expect(panel).toBeHidden()

    expect(policyViolations).toEqual([])
  })
}
