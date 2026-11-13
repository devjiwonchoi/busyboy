import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The journeys type POSIX shell commands into the pinned test shell (/bin/sh).
test.skip(process.platform === 'win32', 'The terminal journeys need a POSIX shell.')

let worktree: string

test.beforeEach(() => {
  // Stands in for a task worktree until tasks exist.
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'busyboy-terminal-')))
})

test.afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

async function openTerminal(page: Page) {
  await page.goto(`/?cwd=${encodeURIComponent(worktree)}`)
  const panel = page.getByRole('region', { name: 'Bottom panel' })
  await expect(panel).toBeHidden()
  // A key pressed before hydration is dropped, so press again only while the
  // panel is still closed; a press that landed is never undone.
  await expect(async () => {
    if (await panel.isHidden()) await page.keyboard.press('ControlOrMeta+j')
    await expect(panel).toBeVisible({ timeout: 1_000 })
  }).toPass()
  const terminal = page.getByRole('region', { name: 'Terminal' })
  await expect(terminal).toBeVisible()
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)
  return terminal
}

async function run(page: Page, command: string) {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test('pressing Cmd+J should open a terminal in the task worktree', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'pwd')
  await expect(terminal.locator('.xterm-rows')).toContainText(worktree)

  // Outside the terminal the shortcut closes the panel again.
  await page.getByRole('main', { name: 'Chat' }).click()
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeHidden()
})

test('pressing Ctrl+` in the terminal should close the panel', async ({ page }) => {
  await openTerminal(page)
  // Off macOS Ctrl+J belongs to the shell here, so Ctrl+` (Cmd+` on macOS) is the way out.
  await page.keyboard.press('ControlOrMeta+Backquote')
  await expect(page.getByRole('region', { name: 'Bottom panel' })).toBeHidden()
})

test('typing a command should show its output', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'echo "busyboy-$((6 * 7))"')
  await expect(terminal.locator('.xterm-rows')).toContainText('busyboy-42')
})

test('exiting the shell should offer a new terminal', async ({ page }) => {
  const terminal = await openTerminal(page)
  await run(page, 'exit 3')
  const status = page.getByRole('status')
  await expect(status).toContainText('The shell exited with code 3.')

  await status.getByRole('button', { name: 'New terminal' }).click()
  await expect(status).toBeHidden()
  await expect(page.getByLabel('Working directory')).toHaveText(worktree)
  await terminal.click()
  await run(page, 'echo "again-$((1 + 1))"')
  await expect(terminal.locator('.xterm-rows')).toContainText('again-2')
})
