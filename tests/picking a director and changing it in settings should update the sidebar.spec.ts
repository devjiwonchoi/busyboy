import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createGitRepository, removeFolder, useTestHome } from './support/test-home'

// The Director is a character picked in setup (Jota is offered first) and changed later in
// settings. The left chat list pins that character above the managers, who wear emoji pictures.

const folders: string[] = []

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder)
})

function readSettings(home: string) {
  return JSON.parse(readFileSync(join(home, 'app-settings.json'), 'utf8')) as { companion: string | null }
}

const chats = (page: Page) => page.getByRole('navigation', { name: 'Chats' })

test('picking a director and changing it in settings should update the sidebar', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000)
  const home = await useTestHome(context, baseURL!, { claude: 'signed-in' })
  folders.push(home)
  const repository = createGitRepository('shop')
  folders.push(dirname(repository))
  await page.emulateMedia({ colorScheme: 'dark' })

  await page.goto('/setup')
  await expect(page.getByRole('heading', { name: 'Pick a Director' })).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Jota the cat/ })).toBeChecked()
  await page.screenshot({ path: test.info().outputPath('setup-default-jota.png'), fullPage: true })

  await page.getByRole('radio', { name: /^Yam the elephant/ }).click()
  await expect(page.getByRole('button', { name: 'Continue with Yam' })).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('setup-picked-yam.png'), fullPage: true })
  await page.getByRole('button', { name: 'Continue with Yam' }).click()

  await expect(page.getByRole('heading', { name: 'Sign in to an agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('link', { name: 'Skip' }).click()
  await expect(page.getByRole('heading', { name: 'Always ask before' })).toBeVisible()
  await page.getByRole('link', { name: 'Skip' }).click()
  await page.getByLabel('Folder path').fill(repository)
  await page.getByRole('button', { name: 'Add folder' }).click()
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('shop')
  await page.getByRole('button', { name: 'Start chatting' }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(chats(page)).toHaveAttribute('data-loaded', 'true')
  const director = chats(page).getByRole('link', { name: 'Yam, director' })
  await expect(director).toBeVisible()
  await expect(chats(page).getByText('Director', { exact: true })).toBeVisible()
  await expect(director.locator('[data-emoji]')).toHaveAttribute('data-emoji', '🐘')
  await expect(chats(page).getByRole('link').first()).toHaveAccessibleName('Yam, director')

  await chats(page).getByRole('button', { name: 'New manager' }).click()
  const form = page.getByRole('dialog', { name: 'New manager' })
  await form.getByRole('textbox', { name: 'Name' }).fill('Webby')
  await form.getByRole('radio', { name: 'shop' }).click()
  await form.getByRole('button', { name: 'Create manager' }).click()

  const manager = chats(page).getByRole('listitem', { name: 'Webby' })
  await expect(manager).toBeVisible()
  await expect(manager.locator('[data-emoji]')).toHaveAttribute('data-emoji', /\p{Extended_Pictographic}/u)
  await expect(chats(page).getByRole('link').first()).toHaveAccessibleName('Yam, director')
  await page.screenshot({ path: test.info().outputPath('sidebar-yam-and-manager.png') })

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Director', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Yam the elephant/ })).toBeChecked()
  await expect(page.locator('dd').filter({ hasText: 'Yam' })).toBeVisible()
  await expect(page.locator('dd').filter({ hasText: 'Formal · encouraging' })).toBeVisible()

  await page.getByRole('radio', { name: /^Jjeromming the squirrel/ }).click()
  await expect.poll(() => readSettings(home).companion).toBe('jjeromming')
  await expect(page.getByRole('radio', { name: /^Jjeromming the squirrel/ })).toBeChecked()
  await expect(page.locator('dd').filter({ hasText: 'Jjeromming' })).toBeVisible()
  await expect(page.locator('dd').filter({ hasText: 'Direct · quick' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('settings-jjeromming.png'), fullPage: true })

  await page.getByRole('link', { name: 'Back to chat' }).click()
  await expect(chats(page)).toHaveAttribute('data-loaded', 'true')
  await expect(chats(page).getByRole('link', { name: 'Jjeromming, director' })).toBeVisible()
  await expect(chats(page).getByRole('link', { name: 'Jjeromming, director' }).locator('[data-emoji]')).toHaveAttribute('data-emoji', '🐿️')
  await expect(chats(page).getByRole('listitem', { name: 'Webby' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('sidebar-jjeromming.png') })
})
