import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { addRecordTask } from './support/record-tasks'
import { useProjectsHome } from './support/projects-home'

// Aligned progress on the chat list. Records live in the journey's jwn root
// (tests/support/record-tasks.ts), the same place /api/records/events reads.

const TITLES = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']

type Verdict = 'pass' | 'fail' | 'pending'

function align(count: number, status = 'approved by ada on 2026-11-01') {
  const items = TITLES.slice(0, count)
    .map((title, index) => `## ${index + 1} · ${title}`)
    .join('\n\n')
  return `# ALIGN: Work\n\nVersion: 1 · Status: ${status}\n\n# End state\n\n${items}\n`
}

function verify(results: Verdict[]) {
  const rows = results.map((result, index) => `| ${index + 1} · ${TITLES[index]} | ${result} | noted |`).join('\n')
  return `| Criterion | Result | Evidence |\n| --- | --- | --- |\n${rows}\n`
}

const OPEN_DECISION = '## Pending\n\n- Root: Which region? · one-way · open · acme/app/task\n'

function writeManagers(home: string, managers: { id: string; name: string; project: string }[]) {
  const file = join(home, 'app-settings.json')
  const settings = JSON.parse(readFileSync(file, 'utf8')) as { managers?: unknown; companion?: string }
  settings.companion = 'jota'
  settings.managers = managers.map((manager) => ({ ...manager, createdAt: new Date(0).toISOString() }))
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

const chats = (page: Page) => page.getByRole('navigation', { name: 'Chats' })
const director = (page: Page) => chats(page).getByRole('link', { name: 'Jota, director' })
// The row's accessible name is the manager's name alone. The link inside also carries the fraction.
const manager = (page: Page, name: string) => chats(page).getByRole('listitem', { name, exact: true }).getByRole('link')

async function open(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await expect(chats(page)).toHaveAttribute('data-loaded', 'true')
}

async function shot(page: Page, name: string) {
  await chats(page).screenshot({ path: test.info().outputPath(name), animations: 'disabled' })
}

test('the chat list should show a calm fraction and nothing for an unaligned project', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web', 'api', 'notes'])
  writeManagers(home, [
    { id: 'webby', name: 'Web', project: 'web' },
    { id: 'apily', name: 'Api', project: 'api' },
    { id: 'notesy', name: 'Notes', project: 'notes' },
  ])
  await addRecordTask(home, {
    project: 'web',
    projectPath: projects.web,
    id: 'web-calm',
    title: 'Ship the footer',
    files: { 'ALIGN.md': align(5), 'VERIFY.md': verify(['pass', 'pass', 'pass', 'pass', 'pass']) },
  })
  await addRecordTask(home, {
    project: 'api',
    projectPath: projects.api,
    id: 'api-calm',
    title: 'Ship the check',
    files: { 'ALIGN.md': align(3), 'VERIFY.md': verify(['pass', 'pass', 'pass']) },
  })
  await addRecordTask(home, {
    project: 'notes',
    projectPath: projects.notes,
    id: 'notes-draft',
    title: 'Draft the plan',
    files: { 'ALIGN.md': align(4, 'draft'), 'VERIFY.md': verify(['pass', 'pass', 'pass', 'pass']) },
  })

  await open(page)
  const list = chats(page)
  await expect(director(page)).toContainText('8/8')
  await expect(director(page)).toHaveAccessibleName('Jota, director, 8/8')
  await expect(director(page).locator('[data-state]')).toHaveCount(0)
  await expect(list.getByText('at risk')).toHaveCount(0)
  await expect(list.getByText('decision')).toHaveCount(0)

  const web = manager(page, 'Web')
  await expect(web).toContainText('5/5')
  await expect(web.locator('[data-state="calm"]')).toHaveClass(/bg-success-foreground/)
  await expect(web.locator('[data-progress]')).toHaveClass(/text-\[#8d8d93\]/)
  await expect(manager(page, 'Api')).toContainText('3/3')
  await expect(manager(page, 'Api').locator('[data-state="calm"]')).toBeVisible()
  await expect(manager(page, 'Notes')).not.toContainText(/\d+\s*\/\s*\d+/)
  await expect(manager(page, 'Notes').locator('[data-progress]')).toHaveCount(0)
  await shot(page, 'sidebar-calm-director.png')

  await web.click()
  await expect(web).toHaveAttribute('aria-current', 'page')
  // The pointer stays on the row after the click, which is where Remove sits. Park it in the chat.
  await page.mouse.move(640, 360)
  await expect(web.getByText('5/5')).toBeVisible()
  await expect(director(page)).toContainText('8/8')
  await expect(manager(page, 'Notes')).not.toContainText(/\d+\s*\/\s*\d+/)
  await shot(page, 'sidebar-calm-project.png')
})

test('the chat list should say at risk or decision only on the project that needs it', async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web', 'api', 'docs', 'notes'])
  writeManagers(home, [
    { id: 'webby', name: 'Web', project: 'web' },
    { id: 'apily', name: 'Api', project: 'api' },
    { id: 'docsy', name: 'Docs', project: 'docs' },
    { id: 'notesy', name: 'Notes', project: 'notes' },
  ])
  await addRecordTask(home, {
    project: 'web',
    projectPath: projects.web,
    id: 'web-risk',
    title: 'Fix the health check',
    files: { 'ALIGN.md': align(5), 'VERIFY.md': verify(['pass', 'pass', 'pass', 'fail', 'pending']) },
  })
  await addRecordTask(home, {
    project: 'api',
    projectPath: projects.api,
    id: 'api-decision',
    title: 'Ask the region',
    files: {
      'ALIGN.md': align(6),
      'VERIFY.md': verify(['pass', 'pass', 'pass', 'pass', 'pending', 'pending']),
      'STATUS.md': OPEN_DECISION,
    },
  })
  await addRecordTask(home, {
    project: 'docs',
    projectPath: projects.docs,
    id: 'docs-calm',
    title: 'Ship the guide',
    files: { 'ALIGN.md': align(5), 'VERIFY.md': verify(['pass', 'pass', 'pass', 'pass', 'pass']) },
  })
  await addRecordTask(home, {
    project: 'notes',
    projectPath: projects.notes,
    id: 'notes-draft',
    title: 'Draft the plan',
    files: { 'ALIGN.md': align(4, 'draft'), 'VERIFY.md': verify(['pass', 'pass', 'pass', 'pass']) },
  })

  await open(page)
  const jota = director(page)
  await expect(jota).toContainText('12/16')
  await expect(jota).not.toContainText('at risk')
  await expect(jota).not.toContainText('decision')
  await expect(jota).toHaveAccessibleName('Jota, director, 12/16, web at risk, api decision')
  const dots = jota.locator('[data-state]')
  await expect(dots).toHaveCount(2)
  await expect(dots.nth(0)).toHaveAttribute('data-state', 'at-risk')
  await expect(dots.nth(0)).toHaveClass(/bg-destructive/)
  await expect(dots.nth(1)).toHaveAttribute('data-state', 'decision')
  await expect(dots.nth(1)).toHaveClass(/bg-warning-foreground/)

  const web = manager(page, 'Web')
  await expect(web).toContainText('3/5 at risk')
  await expect(web).not.toContainText('decision')
  await expect(web.locator('[data-state="at-risk"]')).toHaveClass(/bg-destructive/)
  await expect(web.getByText('at risk')).toHaveClass(/text-destructive/)
  const api = manager(page, 'Api')
  await expect(api).toContainText('4/6 decision')
  await expect(api).not.toContainText('at risk')
  await expect(api.locator('[data-state="decision"]')).toHaveClass(/bg-warning-foreground/)
  await expect(api.getByText('decision')).toHaveClass(/text-warning-foreground/)
  await expect(manager(page, 'Docs')).toContainText('5/5')
  await expect(manager(page, 'Docs')).not.toContainText('at risk')
  await expect(manager(page, 'Docs')).not.toContainText('decision')
  await expect(manager(page, 'Docs').locator('[data-state="calm"]')).toHaveClass(/bg-success-foreground/)
  await expect(manager(page, 'Notes')).not.toContainText(/\d+\s*\/\s*\d+/)
  await shot(page, 'sidebar-attention-director.png')

  await api.click()
  await expect(api).toHaveAttribute('aria-current', 'page')
  // The pointer stays on the row after the click, which is where Remove sits. Park it in the chat.
  await page.mouse.move(640, 360)
  await expect(api.getByText('4/6 decision')).toBeVisible()
  await expect(web.getByText('3/5 at risk')).toBeVisible()
  await expect(jota).toContainText('12/16')
  await expect(jota).not.toContainText('at risk')
  await shot(page, 'sidebar-attention-project.png')
})
