import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'


const SKILLS = [
  ['align', 'Plan the task before changing files.'],
  ['explore', 'Look through the code and report what you find.'],
  ['iterate', 'Revise the work from a review.'],
  ['remember', 'Save what the next task should know.'],
  ['ship', 'Merge, release, and hand the work back.'],
] as const

function installSkills(home: string) {
  for (const [name, description] of SKILLS) {
    const folder = join(home, 'harness-skills', name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow the ${name} skill.\n`)
  }
}

async function finishMenuAnimation(picker: ReturnType<Page['getByRole']>) {
  await picker.evaluate((node) => {
    let current: Element | null = node
    while (current) {
      for (const animation of current.getAnimations()) animation.finish()
      current = current.parentElement
    }
  })
}

async function openChat(page: Page, manager?: string) {
  await page.goto(manager ? `/?manager=${manager}` : '/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

test('picking a skill with the keyboard should send it to the harness', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  installSkills(home)
  await openChat(page)
  const message = page.getByRole('textbox', { name: 'Message' })
  await message.click()
  await message.pressSequentially('/')

  const picker = page.getByRole('listbox', { name: 'Choose a skill or command' })
  await expect(picker.getByRole('option', { name: /align/ })).toBeVisible()
  await expect(picker.getByRole('option', { name: /explore/ })).toBeVisible()
  await expect(picker.getByRole('option', { name: /new task/ })).toBeVisible()
  await expect(picker.getByRole('option', { selected: true })).toContainText('align')
  await finishMenuAnimation(picker)
  await page.screenshot({ path: '/opt/cursor/artifacts/skill-picker.png' })

  await message.press('ArrowDown')
  await expect(picker.getByRole('option', { selected: true })).toContainText('explore')
  await message.press('Escape')
  await expect(picker).toBeHidden()

  await message.pressSequentially('aln')
  await expect(picker.getByRole('option')).toHaveCount(1)
  await expect(picker.getByRole('option', { name: /align/ })).toBeVisible()
  await message.press('Tab')
  await expect(picker).toBeHidden()

  await message.press('Backspace')
  await message.press('Backspace')
  await message.press('Backspace')
  await message.pressSequentially('aln')
  await message.press('Enter')
  await expect(picker).toBeHidden()
  await page.getByRole('button', { name: 'Send' }).click()

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Your message')).toHaveText('/align')
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Using the align skill.')
})

test('picking a Codex skill should send the dollar invocation', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out' })
  installSkills(home)
  await openChat(page)
  const message = page.getByRole('textbox', { name: 'Message' })
  await message.click()
  await message.pressSequentially('/align')

  const picker = page.getByRole('listbox', { name: 'Choose a skill or command' })
  await expect(picker.getByRole('option', { name: /align/ })).toBeVisible()
  await message.press('Enter')
  await page.getByRole('button', { name: 'Send' }).click()

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Your message')).toHaveText('$align')
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Using the align skill.')
})

test('mentioning a project file should send it to the harness', async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web'])
  const settingsFile = join(home, 'app-settings.json')
  const stored = JSON.parse(readFileSync(settingsFile, 'utf8')) as { managers?: unknown[] }
  stored.managers = [{ id: 'webby', name: 'Webby', project: 'web', createdAt: new Date(0).toISOString() }]
  writeFileSync(settingsFile, `${JSON.stringify(stored, null, 2)}\n`)

  await openChat(page, 'webby')
  const message = page.getByRole('textbox', { name: 'Message' })
  await message.click()
  await message.pressSequentially('@')

  const picker = page.getByRole('listbox', { name: 'Choose a file' })
  await expect(picker.getByRole('option', { name: /README\.md/ })).toBeVisible()
  await message.pressSequentially('rm')
  await expect(picker.getByRole('option', { name: /README\.md/ })).toBeVisible()
  await finishMenuAnimation(picker)
  await page.screenshot({ path: '/opt/cursor/artifacts/file-picker.png' })
  await message.press('Enter')
  await expect(picker).toBeHidden()
  await page.getByRole('button', { name: 'Send' }).click()

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByLabel('Your message')).toHaveText('@README.md')
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Read README.md.')
})
