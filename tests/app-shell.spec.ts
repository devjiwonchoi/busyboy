import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`opening the app should show the shell, and shortcuts should toggle the sidebar and panel (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')

    await expect(page).toHaveTitle('Busyboy')
    const chat = page.getByRole('main', { name: 'Chat' })
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
    const panel = page.getByRole('region', { name: 'Bottom panel' })

    await expect(chat).toContainText('Busyboy is ready.')
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toContainText('Nothing here yet.')
    await expect(panel).toBeHidden()

    const appliedScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    expect(appliedScheme).toBe(colorScheme)

    await page.keyboard.press('ControlOrMeta+b')
    await expect(sidebar).toBeHidden()
    await page.keyboard.press('ControlOrMeta+j')
    await expect(panel).toBeVisible()

    await page.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect(sidebar).toBeVisible()
    await page.getByRole('button', { name: 'Toggle bottom panel' }).click()
    await expect(panel).toBeHidden()

    await page.screenshot({ path: test.info().outputPath(`shell-${colorScheme}.png`) })
  })
}
