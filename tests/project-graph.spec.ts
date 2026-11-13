import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

const FOOTER = { id: 'show-health-footer-a1b2c3', title: 'Show API health in the footer' }
const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }

/** web has a task waiting on the user that builds on api's finished task (tests/fixtures/records/). */
async function useRecordHome(context: BrowserContext, baseURL: string) {
  const { home, projects } = await useProjectsHome(context, baseURL, ['web', 'api'])
  addRecordTask(home, { project: 'api', projectPath: projects.api, ...HEALTH })
  const footer = addRecordTask(home, { project: 'web', projectPath: projects.web, ...FOOTER })
  return { home, footer }
}

async function openGraph(page: Page) {
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Projects' }).click()
  return sidebar.getByRole('region', { name: 'Project graph' })
}

test('changing a record file should update the node color', async ({ page, context, baseURL }) => {
  const { footer } = await useRecordHome(context, baseURL!)
  const graph = await openGraph(page)
  const task = graph.getByRole('group', { name: `Task ${FOOTER.title}` })
  await expect(task).toHaveAttribute('data-status', 'needs-you')
  await expect(task).toContainText('Needs you')
  await expect(graph.getByRole('group', { name: 'Todo 2 · Fetch the status' })).toHaveAttribute('data-status', 'needs-you')

  writeFileSync(
    join(footer.records, 'STATUS.md'),
    ['# STATUS: show-health-footer', '', '- Stage: Ship', '- State: done', '', '| Todo | Result |', '|---|---|', '| 1 | done |', '| 2 | done |', '| 3 | done |', ''].join('\n'),
  )

  // The graph must follow a record change within 2 seconds.
  await expect(task).toHaveAttribute('data-status', 'done', { timeout: 2_000 })
  await expect(task).toContainText('Done')
  await expect(graph.getByRole('group', { name: 'Todo 2 · Fetch the status' })).toHaveAttribute('data-status', 'done')
})

test('a malformed record should show an error node', async ({ page, context, baseURL }) => {
  const { footer } = await useRecordHome(context, baseURL!)
  const graph = await openGraph(page)
  const task = graph.getByRole('group', { name: `Task ${FOOTER.title}` })
  await expect(task).toHaveAttribute('data-status', 'needs-you')

  writeFileSync(join(footer.records, 'STATUS.md'), '# STATUS: show-health-footer\n\n- State: sleeping\n')

  await expect(task).toHaveAttribute('data-status', 'error', { timeout: 2_000 })
  await expect(task).toContainText('Could not read the records')
  // Todos from a record that does not parse are not drawn.
  await expect(graph.getByRole('group', { name: 'Todo 1 · Footer component' })).toHaveCount(0)
  await expect(graph.getByRole('group', { name: 'Todo 2 · Fetch the status' })).toHaveCount(0)
  await task.hover()
  await expect(page.getByRole('list', { name: 'Record errors' })).toContainText('STATUS.md: The state "sleeping" is not one busyboy knows.')
  // The other project's task is unaffected.
  await expect(graph.getByRole('group', { name: `Task ${HEALTH.title}` })).toHaveAttribute('data-status', 'done')
})

test('hovering a task node should show its details', async ({ page, context, baseURL }) => {
  await useRecordHome(context, baseURL!)
  const graph = await openGraph(page)
  await expect(graph.getByRole('group', { name: 'Project web' })).toBeVisible()
  await expect(graph.getByRole('group', { name: 'Project api' })).toBeVisible()
  const task = graph.getByRole('group', { name: `Task ${FOOTER.title}` })

  await task.hover()

  const details = page.locator('.react-flow__node-toolbar').filter({ hasText: 'Branch' })
  await expect(details).toBeVisible()
  await expect(details).toContainText(`busyboy/${FOOTER.id}`)
  await expect(details).toContainText('StageIterate')
  await expect(details).toContainText('needing the user to choose how often to poll')
  await expect(details).toContainText('1 of 3 done')
  await expect(details).toContainText('1 passed, 0 failed, 1 pending')
  await expect(details).toContainText('1 open finding')
  await expect(details).toContainText(`api/${HEALTH.id}`)
  // The cross-project link is drawn as a dashed edge.
  const buildsOn = graph.locator('.react-flow__edge.builds-on path.react-flow__edge-path')
  await expect(buildsOn).toHaveCount(1)
  await expect(buildsOn).toHaveCSS('stroke-dasharray', /6(px)?,? 4(px)?/)

  await page.mouse.move(0, 0)
  await expect(details).toBeHidden()
})
