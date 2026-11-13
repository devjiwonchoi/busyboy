import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`opening the app should show the shell, and shortcuts should toggle the sidebar and panel (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')

    await expect(page).toHaveTitle('BusyBoy')
    const chat = page.getByRole('region', { name: 'Chat' })
    // The sidebar slides off-canvas when closed and becomes inert (no focus,
    // no screen reader access), so "shown" means in the viewport and not inert.
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
    const expectSidebarShown = async () => {
      await expect(sidebar).toBeInViewport()
      await expect(sidebar).toHaveJSProperty('inert', false)
    }
    const expectSidebarClosed = async () => {
      await expect(sidebar).not.toBeInViewport()
      await expect(sidebar).toHaveJSProperty('inert', true)
    }
    const panel = page.getByRole('region', { name: 'Bottom panel' })

    await expect(chat).toContainText('BusyBoy is ready.')
    await expectSidebarShown()
    await expect(sidebar).toContainText('Nothing here yet.')
    await expect(panel).toBeHidden()

    const appliedScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    expect(appliedScheme).toBe(colorScheme)

    await page.keyboard.press('ControlOrMeta+b')
    await expectSidebarClosed()
    await page.keyboard.press('ControlOrMeta+j')
    await expect(panel).toBeVisible()

    await page.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expectSidebarShown()
    await page.getByRole('button', { name: 'Toggle bottom panel' }).click()
    await expect(panel).toBeHidden()

    const pressOnLayout = (key: string, code: string) =>
      page.evaluate(
        ([key, code]) => {
          const mac = /Mac/.test(navigator.platform)
          const event = new KeyboardEvent('keydown', { key, code, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })
          window.dispatchEvent(event)
          // A handled shortcut prevents the default action.
          return event.defaultPrevented
        },
        [key, code],
      )

    // Dvorak types 'x' on the physical B key: Cmd/Ctrl+X must stay Cut.
    expect(await pressOnLayout('x', 'KeyB')).toBe(false)
    await expectSidebarShown()

    // A Korean input source types 'ㅠ' on the physical B key: Cmd/Ctrl+B still toggles.
    expect(await pressOnLayout('ㅠ', 'KeyB')).toBe(true)
    await expectSidebarClosed()

    await page.screenshot({ path: test.info().outputPath(`shell-${colorScheme}.png`) })
  })
}
