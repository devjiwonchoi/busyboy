import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { SHUTDOWN_DONE_MESSAGE, SHUTDOWN_MESSAGE } from '../lib/server-shutdown'
import { SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from '../lib/server-token'

const LOOPBACK = '127.0.0.1'
const READY_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
/** How long the server gets to end its child processes before it is killed. */
const SHUTDOWN_TIMEOUT_MS = 4_000

export type ServerHandle = {
  url: string
  token: string
  isRunning: () => boolean
  /** Resolves with whether the server confirmed it ended its child processes. */
  stop: () => Promise<{ acknowledged: boolean }>
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

/** Starts the standalone Next server on a free loopback port behind a per-launch token. */
export async function startServer(): Promise<ServerHandle> {
  const entry = serverEntry()
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
    child.kill()
    throw error
  }

  return {
    url,
    token,
    isRunning: () => running,
    stop: async () => {
      if (!running) return { acknowledged: false }
      // Let the server end its terminals first: on Windows `kill()` terminates
      // the process outright and no exit hook in it runs.
      let acknowledged = false
      const shutdownDone = new Promise<void>((resolve) => {
        child.on('message', (message: { type?: string } | null) => {
          if (message?.type !== SHUTDOWN_DONE_MESSAGE) return
          acknowledged = true
          resolve()
        })
      })
      child.postMessage({ type: SHUTDOWN_MESSAGE })
      await Promise.race([
        shutdownDone,
        exitedPromise,
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ])
      if (!running) return { acknowledged }
      child.kill()
      await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))])
      return { acknowledged }
    },
  }
}
