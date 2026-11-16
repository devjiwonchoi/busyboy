import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createTempFolder, prepareDefaultHome, removeFolder } from './support/test-home'

const root = process.cwd()
const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

type Reply = { status: number; headers: Record<string, string | string[] | undefined> }

/** Sends a raw HTTP request so the Host and Origin headers can be set freely. */
function get(port: number, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

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

/**
 * Starts the built standalone server the way `pnpm start` does, outside test mode.
 * It gets its own data folder with setup complete, so it never reads the real ~/.busyboy.
 */
async function startServer(env: Record<string, string>): Promise<{ port: number; child: ChildProcess }> {
  const port = await freePort()
  const home = createTempFolder('server-home')
  prepareDefaultHome(home)
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.BUSYBOY_TEST_MODE
  delete childEnv.BUSYBOY_TOKEN
  Object.assign(childEnv, env, {
    PORT: String(port),
    BUSYBOY_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
    CODEX_HOME: join(home, 'codex-home'),
  })
  const child = spawn(process.execPath, [join(root, 'scripts', 'start-standalone.mts')], {
    cwd: root,
    env: childEnv,
    stdio: 'ignore',
  })
  child.once('exit', () => removeFolder(home))
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      await get(port, { host: `127.0.0.1:${port}` })
      return { port, child }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  child.kill()
  throw new Error('The standalone server did not start.')
}

test('a request with a foreign Host should be rejected', async () => {
  const allowed = await get(testPort, { host: `127.0.0.1:${testPort}` })
  expect(allowed.status).toBe(200)
  expect(allowed.headers['content-security-policy']).toContain("default-src 'self'")

  expect((await get(testPort, { host: `attacker.example:${testPort}` })).status).toBe(403)
  expect((await get(testPort, { host: `192.168.0.10:${testPort}` })).status).toBe(403)
  expect((await get(testPort, { host: '127.0.0.1:1' })).status).toBe(403)
})

test('a request with a foreign Origin should be rejected', async () => {
  const host = `localhost:${testPort}`
  expect((await get(testPort, { host, origin: `http://${host}` })).status).toBe(200)
  expect((await get(testPort, { host, origin: 'http://attacker.example' })).status).toBe(403)
  expect((await get(testPort, { host, origin: 'http://127.0.0.1:1' })).status).toBe(403)
})

test('a request without a token should be rejected outside test mode', async () => {
  const { port, child } = await startServer({})
  try {
    expect((await get(port, { host: `127.0.0.1:${port}` })).status).toBe(403)
  } finally {
    child.kill()
  }
})

test('a request with the server token should be served outside test mode', async () => {
  const token = 'journey-token'
  const { port, child } = await startServer({ BUSYBOY_TOKEN: token })
  try {
    const host = `127.0.0.1:${port}`
    expect((await get(port, { host })).status).toBe(403)
    expect((await get(port, { host, 'x-busyboy-token': 'wrong-token-value' })).status).toBe(403)
    expect((await get(port, { host, 'x-busyboy-token': token })).status).toBe(200)
    expect((await get(port, { host, cookie: `busyboy-token=${token}` })).status).toBe(200)
  } finally {
    child.kill()
  }
})
