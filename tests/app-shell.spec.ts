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

    const pressOnLayout = (key: string, code: string) =>
      page.evaluate(
        ([key, code]) => {
          const mac = /Mac/.test(navigator.platform)
          window.dispatchEvent(new KeyboardEvent('keydown', { key, code, metaKey: mac, ctrlKey: !mac, bubbles: true }))
        },
        [key, code],
      )

    // Dvorak types 'x' on the physical B key: Cmd/Ctrl+X must stay Cut.
    await pressOnLayout('x', 'KeyB')
    await expect(sidebar).toBeVisible()

    // A Korean input source types 'ㅠ' on the physical B key: Cmd/Ctrl+B still toggles.
    await pressOnLayout('ㅠ', 'KeyB')
    await expect(sidebar).toBeHidden()

    await page.screenshot({ path: test.info().outputPath(`shell-${colorScheme}.png`) })
  })
}
