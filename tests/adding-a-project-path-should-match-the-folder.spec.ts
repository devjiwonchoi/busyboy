import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import { createGitRepository, removeFolder, useTestHome } from './support/test-home'

function otherSpelling(folder: string) {
  const slashed = folder.endsWith('/') || folder.endsWith('\\') ? folder : `${folder}${sep}`
  if (process.platform !== 'win32') return slashed
  const forward = slashed.replaceAll('\\', '/')
  const drive = forward[0] === forward[0].toUpperCase() ? forward[0].toLowerCase() : forward[0].toUpperCase()
  return drive + forward.slice(1)
}

const folders: string[] = []

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder)
})

test('adding a folder that is already a project under another spelling should not add it twice', async ({ page, context, baseURL }) => {
  const home = await useTestHome(context, baseURL!, { claude: 'signed-in' })
  folders.push(home)
  const repository = createGitRepository('shop')
  folders.push(join(repository, '..'))
  const settings = {
    version: 1,
    setupCompletedAt: new Date(0).toISOString(),
    defaultProvider: null,
    companion: 'nori',
    companionImage: null,
    projects: [{ name: 'shop', path: otherSpelling(repository), addedAt: new Date(0).toISOString() }],
    managers: [],
    alwaysAsk: null,
  }
  writeFileSync(join(home, 'app-settings.json'), `${JSON.stringify(settings, null, 2)}\n`)

  await page.goto('/settings?section=projects')
  const projects = page.getByRole('listitem').filter({ hasText: 'shop' })
  await expect(projects).toHaveCount(1)

  await page.getByLabel('Folder path').fill(repository)
  await page.getByRole('button', { name: 'Add folder' }).click()

  await expect(page.getByText('This folder is already added as shop.')).toBeVisible()
  await expect(projects).toHaveCount(1)
})

test('adding a home shortcut should add that folder', async ({ page, context, baseURL }) => {
  const home = await useTestHome(context, baseURL!, { claude: 'signed-in' })
  folders.push(home)
  const name = `busyboy-e2e-${Date.now().toString(36)}`
  const repository = join(homedir(), name)
  folders.push(repository)
  mkdirSync(repository)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repository, 'README.md'), `# ${name}\n`)
  git('add', '.')
  git('-c', 'user.name=BusyBoy Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Initial commit')
  writeFileSync(
    join(home, 'app-settings.json'),
    `${JSON.stringify({ version: 1, setupCompletedAt: new Date(0).toISOString(), defaultProvider: null, companion: 'nori', companionImage: null, projects: [], managers: [], alwaysAsk: null }, null, 2)}\n`,
  )

  await page.goto('/settings?section=projects')
  const typed = process.platform === 'win32' ? `~\\${name}` : `~/${name}`
  await page.getByLabel('Folder path').fill(typed)
  await page.getByRole('button', { name: 'Add folder' }).click()

  await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible()
})
