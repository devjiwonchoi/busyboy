import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from '../lib/server-token'

const LOOPBACK = '127.0.0.1'
const READY_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const START_ATTEMPTS = 3

export type ServerHandle = {
  url: string
  token: string
  isRunning: () => boolean
  stop: () => Promise<void>
}

/** The standalone server sits outside app.asar in packaged builds. */
function serverEntry() {
  const entry = app.isPackaged
    ? join(process.resourcesPath, 'server', 'server.js')
    : join(app.getAppPath(), '.next', 'standalone', 'server.js')
  if (!existsSync(entry)) {
    throw new Error(`No Next server at ${entry}. Run \`pnpm build\` first.`)
  }
  return entry
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address()
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Could not read the probe port.'))
      })
    })
  })
}

async function waitUntilReady(url: string, token: string, exited: () => boolean) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited()) throw new Error('The Next server exited before it was ready.')
    try {
      const response = await fetch(url, { headers: { [SERVER_TOKEN_HEADER]: token } })
      await response.body?.cancel()
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`The Next server was not ready within ${READY_TIMEOUT_MS} ms.`)
}

type Attempt = { kind: 'ready'; handle: ServerHandle } | { kind: 'exited'; port: number }

async function startOnFreePort(entry: string): Promise<Attempt> {
  const port = await findFreePort()
  const token = randomBytes(32).toString('hex')
  const url = `http://${LOOPBACK}:${port}`

  const child: UtilityProcess = utilityProcess.fork(entry, [], {
    cwd: dirname(entry),
    serviceName: 'Busyboy Server',
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: LOOPBACK,
      PORT: String(port),
      [SERVER_TOKEN_ENV]: token,
    },
  })

  let running = true
  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      running = false
      resolve()
    })
  })

  try {
    await waitUntilReady(url, token, () => !running)
  } catch (error) {
    // Exiting before ready is most often a lost race for the port.
    if (!running) return { kind: 'exited', port }
    child.kill()
    throw error
  }

  return {
    kind: 'ready',
    handle: {
      url,
      token,
      isRunning: () => running,
      stop: async () => {
        if (!running) return
        child.kill()
        await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))])
      },
    },
  }
}

/**
 * Starts the standalone Next server on a free loopback port behind a per-launch
 * token. Another process can take the port between the probe and the server's
 * listen, so an early exit is retried on a new port.
 */
export async function startServer(): Promise<ServerHandle> {
  const entry = serverEntry()
  const triedPorts: number[] = []
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const result = await startOnFreePort(entry)
    if (result.kind === 'ready') return result.handle
    triedPorts.push(result.port)
  }
  throw new Error(`The Next server exited before it was ready on ports ${triedPorts.join(', ')}.`)
}
