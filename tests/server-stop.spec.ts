import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { createTempFolder, removeFolder } from './support/test-home'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No port'))))
    })
  })
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('stopping the server should end the processes its agents started', async ({ browser }) => {
  test.skip(process.platform === 'win32', 'The fake Claude CLI is a POSIX process-group script.')
  const port = await freePort()
  const home = createTempFolder('stop-home')
  const pidFile = join(home, 'fake-claude.pid')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.BUSYBOY_TOKEN
  Object.assign(env, {
    PORT: String(port),
    BUSYBOY_TEST_MODE: '1',
    BUSYBOY_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
    BUSYBOY_CLAUDE_PATH: join(process.cwd(), 'tests/fake-claude/claude.sh'),
    FAKE_CLAUDE_PID_FILE: pidFile,
  })
  const server = spawn(process.execPath, [join(process.cwd(), 'scripts', 'start-standalone.mts')], { env, stdio: 'ignore' })
  const baseURL = `http://127.0.0.1:${port}`
  try {
    await expect.poll(() => fetch(baseURL).then(() => true, () => false), { timeout: 20_000 }).toBe(true)
    const context = await browser.newContext({ baseURL })
    const { home: dataHome } = await useProjectsHome(context, baseURL, [], { claude: 'signed-in' })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
    await page.getByRole('textbox', { name: 'Message' }).fill('Start working.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => existsSync(pidFile)).toBe(true)
    const children = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)
    expect(children.every(isRunning)).toBe(true)

    server.kill('SIGTERM')

    await expect.poll(() => children.filter(isRunning), { timeout: 15_000 }).toEqual([])
    await context.close()
    removeFolder(dataHome)
  } finally {
    server.kill('SIGKILL')
    removeFolder(home)
  }
})
