import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createTempFolder, prepareDefaultHome, removeFolder } from './test-home'

const root = join(__dirname, '..', '..')

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No port'))))
    })
  })
}

/**
 * A built standalone server of its own, in test mode, for journeys that stop
 * or restart it without touching the shared ones. `restart` starts it again
 * on the same port and data folder, so a browser context's cookies still apply.
 */
export async function startStandaloneServer(env: Record<string, string> = {}) {
  const port = await freePort()
  const home = createTempFolder('standalone-home')
  prepareDefaultHome(home)
  const baseURL = `http://127.0.0.1:${port}`
  let child: ChildProcess
  let exited: Promise<void>

  const start = async () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv.BUSYBOY_TOKEN
    Object.assign(childEnv, {
      PORT: String(port),
      BUSYBOY_TEST_MODE: '1',
      BUSYBOY_PROVIDER_SCRIPTS: join(root, 'tests/provider-scripts'),
      BUSYBOY_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
      CODEX_HOME: join(home, 'codex-home'),
      ...env,
    })
    child = spawn(process.execPath, [join(root, 'scripts', 'start-standalone.mts')], { cwd: root, env: childEnv, stdio: 'ignore' })
    exited = new Promise((resolve) => child.once('exit', () => resolve()))
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await fetch(baseURL).then(() => true, () => false)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill('SIGKILL')
    throw new Error('The standalone server did not start.')
  }

  await start()
  return {
    baseURL,
    /** Sends `signal` and waits until the process has exited. */
    async stop(signal: NodeJS.Signals = 'SIGKILL') {
      child.kill(signal)
      await exited
    },
    /** Sends `signal` without waiting, for a server that is expected to stay up for a while. */
    signal: (signal: NodeJS.Signals) => child.kill(signal),
    restart: start,
    async dispose() {
      child.kill('SIGKILL')
      await exited
      removeFolder(home)
    },
  }
}
