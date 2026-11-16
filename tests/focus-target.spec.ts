import { expect, test } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

// The window opening on the item a tray entry or notification points at
// (src/components/shell/focus-handler.tsx).

const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }
const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }

test('opening a task from the tray should show it in the project graph', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web', 'api'])
  addRecordTask(home, { project: 'api', projectPath: projects.api, ...HEALTH })
  addRecordTask(home, { project: 'web', projectPath: projects.web, ...FOOTER })

  // A fresh window opens on `?focus=`; an open one gets the same target through the desktop bridge.
  await page.goto(`/?focus=${encodeURIComponent(`task:web/${FOOTER.id}`)}`)

  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await expect(sidebar.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true')
  const graph = sidebar.getByRole('region', { name: 'Project graph' })
  await expect(graph.getByRole('group', { name: `Task ${FOOTER.title}` })).toHaveAttribute('data-dimmed', 'false')
  await expect(graph.getByRole('group', { name: 'Project web' })).toHaveAttribute('data-dimmed', 'false')
  await expect(graph.getByRole('group', { name: `Task ${HEALTH.title}` })).toHaveAttribute('data-dimmed', 'true')
  // The target is used once; a reload shows the plain main screen.
  await expect(page).toHaveURL(/\/$/)
})

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
