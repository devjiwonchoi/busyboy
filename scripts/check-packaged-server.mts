// Fails the build unless the packaged server works on its own: it copies the
// server folder out of the repository (so no repository node_modules is
// reachable), loads every package in src/lib/server-external-packages.ts with
// Electron's Node, and starts the server.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serverExternalPackages } from '../src/lib/server-external-packages.ts'
import { SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from '../src/lib/server-token.ts'

const READY_TIMEOUT_MS = 30_000
const LOADER_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 10_000

// Importing a package does not always load what it needs at runtime. These
// smoke tests exercise it: node-pty loads its native binding lazily on Windows
// and runs spawn-helper only when it spawns, so it spawns a shell that exits.
const smokeTests: Record<string, string> = {
  'node-pty': `const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
const args = process.platform === 'win32' ? ['/c', 'exit 0'] : ['-c', 'exit 0']
const child = mod.spawn(shell, args, {})
const code = await new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)))
if (code !== 0) throw new Error(\`a shell spawned through node-pty exited with \${code}\`)`,
}

// The electron package resolves to the path of its binary when loaded from Node.
const electronBinary = createRequire(import.meta.url)('electron') as string

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

// Runs with Electron's Node (ELECTRON_RUN_AS_NODE), the same runtime and ABI
// as the server's utilityProcess, so native modules load as they will in the
// app. NODE_PATH and NODE_OPTIONS are cleared so nothing outside the copied
// folder can be found.
function isolatedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NEXT_TELEMETRY_DISABLED: '1', ...extra }
  delete env.NODE_PATH
  delete env.NODE_OPTIONS
  return env
}

async function startServer(dir: string) {
  const port = await freePort()
  const token = randomBytes(16).toString('hex')
  const url = `http://127.0.0.1:${port}/`
  const child = spawn(electronBinary, ['server.js'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: isolatedEnv({ NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), [SERVER_TOKEN_ENV]: token }),
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`The packaged server exited with ${child.exitCode}:\n${stderr}`)
      try {
        const response = await fetch(url, { headers: { [SERVER_TOKEN_HEADER]: token }, signal: AbortSignal.timeout(2000) })
        await response.body?.cancel()
        if (response.ok) return
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`The packaged server did not answer within ${READY_TIMEOUT_MS} ms:\n${stderr}`)
  } finally {
    // Wait for the exit so its folder is no longer in use (Windows locks it).
    child.kill()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS))])
  }
}

export async function checkPackagedServer(serverDir: string) {
  const isolated = mkdtempSync(join(tmpdir(), 'busyboy-server-check-'))
  const dir = join(isolated, 'server')
  try {
    cpSync(serverDir, dir, { recursive: true, verbatimSymlinks: true })
    const loader = join(dir, 'check-server-packages.mjs')
    writeFileSync(
      loader,
      `const smokeTests = ${JSON.stringify(smokeTests)}
const failures = []
for (const name of ${JSON.stringify(serverExternalPackages)}) {
  try {
    const imported = await import(name)
    const mod = imported.default ?? imported
    if (smokeTests[name]) await new Function('mod', \`return (async () => { \${smokeTests[name]} })()\`)(mod)
  } catch (error) {
    failures.push(\`\${name}: \${error instanceof Error ? error.message : String(error)}\`)
  }
}
if (failures.length > 0) {
  console.error(failures.join('\\n'))
  process.exit(1)
}
// Exit even if a package keeps handles open (for example conpty on Windows).
process.exit(0)
`,
    )
    try {
      execFileSync(electronBinary, [loader], {
        cwd: dir,
        env: isolatedEnv({}),
        stdio: ['ignore', 'inherit', 'pipe'],
        timeout: LOADER_TIMEOUT_MS,
      })
    } catch (error) {
      const { stderr, status, signal } = error as { stderr?: Buffer; status?: number | null; signal?: string | null }
      throw new Error(
        `The packaged server cannot load its external packages on its own (exit ${status ?? 'none'}, signal ${signal ?? 'none'}):\n${stderr?.toString() ?? ''}`,
      )
    }
    rmSync(loader)
    await startServer(dir)
  } finally {
    try {
      rmSync(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      // Never hide the check's own result behind a cleanup failure.
      console.warn(`[build-desktop] Could not remove ${isolated}: ${String(error)}`)
    }
  }
  console.log(`[build-desktop] The packaged server loads ${serverExternalPackages.join(', ')} and starts on its own.`)
}
