import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

const harnessFile = (home: string, chat?: string) =>
  join(home, chat ? `managers/${chat}` : 'director', 'harness.json')

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('choosing a harness for a chat should keep it on that chat', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-in', codex: 'signed-in' })
  await openChat(page)
  const harness = page.getByRole('group', { name: 'Harness' })
  await expect(harness.getByLabel('Harness', { exact: true })).toHaveValue('claude')

  await harness.getByLabel('Model').fill('opus')
  await harness.getByLabel('Model').blur()
  await harness.getByLabel('Effort').selectOption('high')
  await expect.poll(() => JSON.parse(readFileSync(harnessFile(home), 'utf8'))).toEqual({ provider: 'claude', model: 'opus', effort: 'high' })

  await page.getByRole('textbox', { name: 'Message' }).fill('What does git worktree do? Answer in one sentence.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByLabel('Reply', { exact: true })).toContainText('check out more than one branch')
  expect(JSON.parse(readFileSync(join(home, 'director', 'harness-start.json'), 'utf8'))).toEqual({
    provider: 'claude',
    model: 'opus',
    effort: 'high',
  })

  await harness.getByLabel('Harness', { exact: true }).selectOption('codex')
  await harness.getByLabel('Model').fill('gpt-5.4')
  await harness.getByLabel('Model').blur()
  await harness.getByLabel('Effort').selectOption('xhigh')
  await expect.poll(() => JSON.parse(readFileSync(harnessFile(home), 'utf8'))).toEqual({
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'xhigh',
  })
  await page.reload()
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await expect(page.getByRole('group', { name: 'Harness' }).getByLabel('Harness', { exact: true })).toHaveValue('codex')
  await expect(page.getByLabel('Model')).toHaveValue('gpt-5.4')
  await expect(page.getByLabel('Effort')).toHaveValue('xhigh')
  await page.screenshot({ path: '/opt/cursor/artifacts/harness-picker.png' })

  await page.getByRole('button', { name: 'New manager' }).click()
  await page.getByRole('dialog', { name: 'New manager' }).getByLabel('Name').fill('Ada')
  await page.getByRole('radio', { name: 'web' }).click()
  await page.getByRole('button', { name: 'Create manager' }).click()
  await expect(page.getByRole('log', { name: 'Transcript' }).getByText('Ada, manager of web')).toBeVisible()
  const manager = page.getByRole('group', { name: 'Harness' })
  await expect(manager.getByLabel('Harness', { exact: true })).toHaveValue('claude')
  await expect(manager.getByLabel('Model')).toHaveValue('')
  await expect(manager.getByLabel('Effort')).toHaveValue('')

  const id = new URL(page.url()).searchParams.get('manager')
  expect(JSON.parse(readFileSync(harnessFile(home), 'utf8')).provider).toBe('codex')
  expect(id).toBeTruthy()
})
