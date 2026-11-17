import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const DIRECTOR_DRAFT = 'Hold onto this thought'
const MANAGER_DRAFT = 'A note for Webby'

function addManager(home: string) {
  const file = join(home, 'app-settings.json')
  const settings = JSON.parse(readFileSync(file, 'utf8')) as { managers?: unknown[] }
  const manager = { id: 'webby', name: 'Webby', project: 'web', createdAt: new Date(0).toISOString() }
  writeFileSync(file, `${JSON.stringify({ ...settings, managers: [...(settings.managers ?? []), manager] }, null, 2)}\n`)
  return manager
}

async function openChat(page: Page, manager?: string) {
  await page.goto(manager ? `/?manager=${manager}` : '/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('a composer draft should survive a chat switch and a reload', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const manager = addManager(home)
  await openChat(page)
  const box = page.getByRole('textbox', { name: 'Message' })

  await box.fill(DIRECTOR_DRAFT)
  await expect.poll(() => box.innerText()).toBe(DIRECTOR_DRAFT)

  await openChat(page, manager.id)
  const managerBox = page.getByRole('textbox', { name: 'Message' })
  await expect(managerBox).toHaveAttribute('aria-placeholder', 'Message Webby')
  await expect.poll(() => managerBox.innerText()).toBe('')
  await managerBox.fill(MANAGER_DRAFT)
  await expect.poll(() => managerBox.innerText()).toBe(MANAGER_DRAFT)

  await openChat(page)
  await expect.poll(() => page.getByRole('textbox', { name: 'Message' }).innerText()).toBe(DIRECTOR_DRAFT)

  await page.reload()
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await expect.poll(() => page.getByRole('textbox', { name: 'Message' }).innerText()).toBe(DIRECTOR_DRAFT)

  await openChat(page, manager.id)
  await expect.poll(() => page.getByRole('textbox', { name: 'Message' }).innerText()).toBe(MANAGER_DRAFT)
})
