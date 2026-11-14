import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`opening the app should show the shell, and shortcuts should toggle the sidebar and panel (${colorScheme})`, async ({
    page,
  }) => {
    const policyViolations: string[] = []
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) policyViolations.push(message.text())
    })
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
    await expect(sidebar.getByRole('tab', { name: 'Projects' })).toBeVisible()
    await expect(sidebar.getByRole('tab', { name: 'Memory' })).toBeVisible()
    await expect(sidebar.getByRole('tab', { name: 'Side chat' })).toBeVisible()
    await expect(panel).toBeHidden()

    const appliedScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    expect(appliedScheme).toBe(colorScheme)

    await page.keyboard.press('ControlOrMeta+Alt+s')
    await expectSidebarClosed()
    await page.keyboard.press('ControlOrMeta+j')
    await expect(panel).toBeVisible()

    await page.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expectSidebarShown()
    await page.getByRole('button', { name: 'Toggle bottom panel' }).click()
    await expect(panel).toBeHidden()

    const pressOnLayout = (key: string, code: string, altKey = false) =>
      page.evaluate(
        ([key, code, altKey]) => {
          const mac = /Mac/.test(navigator.platform)
          const event = new KeyboardEvent('keydown', { key, code, altKey, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })
          window.dispatchEvent(event)
          // A handled shortcut prevents the default action.
          return event.defaultPrevented
        },
        [key, code, altKey] as const,
      )

    // Plain Cmd/Ctrl+S stays Save, and Option on macOS types 'ß' on the S key: matched by position.
    expect(await pressOnLayout('s', 'KeyS')).toBe(false)
    await expectSidebarShown()
    expect(await pressOnLayout('ß', 'KeyS', true)).toBe(true)
    await expectSidebarClosed()
    expect(await pressOnLayout('ß', 'KeyS', true)).toBe(true)
    await expectSidebarShown()

    // A Korean input source types 'ㄴ' on the physical S key: the shortcut still toggles.
    expect(await pressOnLayout('ㄴ', 'KeyS', true)).toBe(true)
    await expectSidebarClosed()

    expect(policyViolations).toEqual([])

    await page.screenshot({ path: test.info().outputPath(`shell-${colorScheme}.png`) })
  })
}
