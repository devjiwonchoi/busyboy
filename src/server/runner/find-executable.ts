import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

function isExecutable(candidate: string) {
  try {
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

// npm's Windows .cmd shim cannot be spawned without a shell. The real target is a .exe or a .js entry.
function resolveWindowsShim(shim: string) {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  for (const match of text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:exe|js|cjs|mjs))"/gi)) {
    if (/(^|\\)node\.exe$/i.test(match[1]!)) continue
    const target = resolve(dirname(shim), match[1]!)
    if (isExecutable(target)) return target
  }
  return undefined
}

function searchPath(name: string, pathValue: string) {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    if (process.platform !== 'win32') {
      const candidate = join(directory, name)
      if (isExecutable(candidate)) return candidate
      continue
    }
    const exe = join(directory, `${name}.exe`)
    if (isExecutable(exe)) return exe
    const shim = join(directory, `${name}.cmd`)
    if (isExecutable(shim)) {
      const target = resolveWindowsShim(shim)
      if (target) return target
    }
  }
  return undefined
}

export function findExecutable(name: string): string | undefined {
  return searchPath(name, process.env.PATH ?? '')
}

/**
 * BusyBoy's own variables, which must never reach an agent or the commands it
 * runs: the server token would let an agent call this server (answer its own
 * approvals, start agents, read transcripts), and the server's PORT, HOSTNAME
 * and NODE_ENV would change how the agent's commands behave.
 */
function isServerVariable(name: string) {
  const upper = name.toUpperCase()
  return (
    upper.startsWith('BUSYBOY_') ||
    upper.startsWith('__NEXT') ||
    upper === 'PORT' ||
    upper === 'HOSTNAME' ||
    upper === 'NODE_ENV' ||
    upper === 'NEXT_RUNTIME' ||
    upper === 'ELECTRON_RUN_AS_NODE'
  )
}

/**
 * The environment every agent process runs with. Every adapter must use it:
 * this process's environment without BusyBoy's own variables.
 */
export function agentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isServerVariable(name)) env[name] = value
  }
  return env
}
