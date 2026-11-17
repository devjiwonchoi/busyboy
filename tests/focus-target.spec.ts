import { expect, test } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The window opening on the item a tray entry or notification points at
// (src/components/shell/focus-handler.tsx). A task target used to open the
// project graph; that panel is gone, so only the Director target remains.

test('opening the Director from the desktop bridge should focus the message box', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, [])
  // Stands in for electron/preload.ts: the test calls the listener the way the main process does.
  await page.addInitScript(() => {
    const listeners: ((target: string) => void)[] = []
    ;(window as unknown as Record<string, unknown>).busyboyDesktop = {
      pickFolders: async () => [],
      pathForFile: () => '',
      onFocus: (listener: (target: string) => void) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    }
    ;(window as unknown as Record<string, unknown>).sendFocus = (target: string) => listeners.forEach((listener) => listener(target))
  })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page.getByRole('textbox', { name: 'Message' })).not.toBeFocused()

  await page.evaluate(() => (window as unknown as { sendFocus: (target: string) => void }).sendFocus('director'))

  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused()
})
