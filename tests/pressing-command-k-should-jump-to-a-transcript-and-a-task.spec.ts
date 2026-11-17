import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Cmd+K searches Director and manager transcripts and task titles. Cmd+N starts a new manager.

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

async function press(page: Page, key: string, dialog: string) {
  // A key pressed before hydration is dropped, so press again until the dialog opens.
  await expect(async () => {
    if (await page.getByRole('dialog', { name: dialog }).isHidden()) await page.keyboard.press(key)
    await expect(page.getByRole('dialog', { name: dialog })).toBeVisible({ timeout: 1_000 })
  }).toPass()
}

test('pressing Cmd+K should jump to a transcript line and a task title', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const settingsFile = join(home, 'app-settings.json')
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { managers?: unknown[] }
  settings.managers = [{ id: 'nova01', name: 'Nova', project: 'web', createdAt: '2026-01-01T00:00:00.000Z' }]
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  mkdirSync(join(home, 'director'), { recursive: true })
  writeFileSync(
    join(home, 'director', 'transcript.jsonl'),
    [
      line({ id: 'user-light', at: '2026-01-01T00:00:00.000Z', kind: 'user', text: 'Where is the lighthouse manual?' }),
      line({ id: 'dir-light', at: '2026-01-01T00:00:01.000Z', kind: 'director', text: 'The lighthouse manual is on the shelf.' }),
      line({ id: 'tasks-1', at: '2026-01-01T00:00:02.000Z', kind: 'tasks', taskIds: ['rename-health'] }),
    ].join(''),
  )
  mkdirSync(join(home, 'managers', 'nova01'), { recursive: true })
  writeFileSync(
    join(home, 'managers', 'nova01', 'transcript.jsonl'),
    line({ id: 'mgr-note', at: '2026-01-01T00:00:03.000Z', kind: 'user', text: 'Remember the quarterly deploy notes.' }),
  )
  writeFileSync(
    join(home, 'task-list.json'),
    `${JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'rename-health',
          project: 'web',
          title: 'Rename the health footer',
          request: 'Rename the health footer',
          provider: 'claude',
          agentId: 'no-agent-rename-health',
          sessionId: null,
          worktree: join(home, 'missing-worktree'),
          branch: 'busyboy/rename-health',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })}\n`,
  )
  await openChat(page)
  await expect(page.getByText('Where is the lighthouse manual?')).toBeVisible()

  await press(page, 'ControlOrMeta+k', 'Commands')
  const search = page.getByRole('textbox', { name: 'Search chats and commands' })
  await search.fill('quarterly deploy')
  const hit = page.getByRole('option', { name: /quarterly deploy notes/ })
  await expect(hit).toBeVisible()
  await page.screenshot({ path: '/opt/cursor/artifacts/command-palette.png' })
  await hit.click()
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden()

  await expect(page).toHaveURL(/manager=nova01/)
  await expect(page).toHaveURL(/#entry-mgr-note/)
  const current = page.locator('[data-current="true"]')
  await expect(current).toBeVisible()
  await expect(current).toContainText('Remember the quarterly deploy notes.')

  await press(page, 'ControlOrMeta+k', 'Commands')
  await page.getByRole('textbox', { name: 'Search chats and commands' }).fill('health footer')
  const commands = page.getByRole('listbox', { name: 'Commands' })
  await expect(commands).toContainText('Rename the health footer')
  await commands.getByRole('option', { name: /Rename the health footer/ }).click()

  await expect(page).toHaveURL(/#task-rename-health/)
  await expect(page.locator('[data-jump-id="task-rename-health"]')).toHaveAttribute('data-current', 'true')
  await expect(page.getByRole('listitem', { name: 'web · Rename the health footer' })).toBeVisible()
})

test('the command palette should switch chats and open settings', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const settingsFile = join(home, 'app-settings.json')
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { managers?: unknown[] }
  settings.managers = [{ id: 'nova01', name: 'Nova', project: 'web', createdAt: '2026-01-01T00:00:00.000Z' }]
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  await openChat(page)

  await press(page, 'ControlOrMeta+k', 'Commands')
  await page.getByRole('option', { name: 'Switch to Nova' }).click()
  await expect(page).toHaveURL(/manager=nova01/)
  await expect(page.getByRole('log', { name: 'Transcript' }).getByText('Nova, manager of web')).toBeVisible()

  await press(page, 'ControlOrMeta+k', 'Commands')
  await expect(page.getByRole('option', { name: 'Switch to BusyBoy' })).toBeVisible()
  await page.getByRole('option', { name: 'Settings', exact: true }).click({ force: true })
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
})

test('pressing Cmd+N should start a new manager', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])
  await openChat(page)

  await press(page, 'ControlOrMeta+k', 'Commands')
  await page.getByRole('option', { name: 'New task' }).click({ force: true })
  await expect(page.getByRole('dialog', { name: 'New manager' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'New manager' })).toBeHidden()

  await press(page, 'ControlOrMeta+n', 'New manager')
  const form = page.getByRole('dialog', { name: 'New manager' })
  await form.getByRole('textbox', { name: 'Name' }).fill('Ada')
  await form.getByRole('radio', { name: 'web' }).click()
  await form.getByRole('button', { name: 'Create manager' }).click()

  await expect(page).toHaveURL(/manager=/)
  await expect(page.getByRole('log', { name: 'Transcript' }).getByText('Ada, manager of web')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Ada' })).toHaveAttribute('aria-current', 'page')
})
