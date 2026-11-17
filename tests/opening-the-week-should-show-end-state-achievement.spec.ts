import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// Records committed on main, not the worktree. Health and the release notes
// landed in the week of Nov 9 (2 of 2, and 0 of 2). The footer landed in the
// week of Nov 2 (1 of 2). The week share is the items added together.
const FIXTURES = join(__dirname, 'fixtures', 'end-state')
const COMMITS: { id: string; date: string }[] = [
  { id: 'ship-footer-ef56gh', date: '2026-11-03T15:00:00Z' },
  { id: 'ship-health-ab12cd', date: '2026-11-10T15:00:00Z' },
  { id: 'ship-notes-cd34ef', date: '2026-11-12T15:00:00Z' },
]

function commitRecords(repo: string) {
  for (const { id, date } of COMMITS) {
    const records = join(repo, '.jwn', id)
    mkdirSync(records, { recursive: true })
    cpSync(join(FIXTURES, id), records, { recursive: true })
    execFileSync('git', ['add', '.jwn'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=BusyBoy Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', `Record ${id}`], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
  }
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })
const doneCard = (page: Page, title: string) => transcript(page).getByRole('group', { name: `Done from web · ${title}` })

test('opening the week should show each task’s end state achievement', async ({ page, context, baseURL }) => {
  const { projects } = await useProjectsHome(context, baseURL!, ['web'])
  commitRecords(projects.web)

  await page.goto('/')
  await expect(transcript(page)).toHaveAttribute('data-connected', 'true')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('tab', { name: 'Week' }).click()
  const week = sidebar.getByRole('region', { name: 'End state achievement' })
  await expect(week).toHaveAttribute('data-loaded', 'true')

  // 2 met of 2, plus 0 met of 2, in the same week.
  const later = week.getByRole('group', { name: 'Nov 9 – Nov 15, End state achievement 2/4' })
  await expect(later).toBeVisible()
  await expect(later.getByRole('listitem', { name: 'Ship the health endpoint, End state achievement 2/2' })).toBeVisible()
  await expect(later.getByRole('listitem', { name: 'Ship the release notes, End state achievement 0/2' })).toBeVisible()
  const earlier = week.getByRole('group', { name: 'Nov 2 – Nov 8, End state achievement 1/2' })
  await expect(earlier).toBeVisible()
  await expect(earlier.getByRole('listitem', { name: 'Ship the footer status, End state achievement 1/2' })).toBeVisible()

  // The same shares sit on the done line, next to Done. View plan stays; nothing else is added.
  const health = doneCard(page, 'Ship the health endpoint')
  await expect(health).toContainText('Ship the health endpoint · Done · 2/2 end state')
  await expect(health.getByRole('button', { name: 'View plan' })).toBeVisible()
  await expect(health.getByRole('button')).toHaveCount(1)
  await expect(doneCard(page, 'Ship the release notes')).toContainText('· Done · 0/2 end state')
  await expect(doneCard(page, 'Ship the footer status')).toContainText('· Done · 1/2 end state')
})
