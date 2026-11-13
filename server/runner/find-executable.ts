import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

const MARKER = '__BUSYBOY_PATH__'
let loginShellPath: Promise<string> | undefined

/**
 * The PATH of the user's login shell. The desktop app already merges it into
 * the server's environment; this covers servers started some other way (for
 * example from the Dock-launched app in dev, or a minimal launchd PATH).
 */
function readLoginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('')
  loginShellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    // Both calls take runtime paths; without the hint Turbopack traces the whole project.
    execFile(
      /*turbopackIgnore: true*/ shell,
      ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      { timeout: 5000, encoding: 'utf8' },
      (_error, stdout) => resolve(stdout?.match(new RegExp(`${MARKER}(.*)${MARKER}`, 's'))?.[1]?.trim() ?? ''),
    )
  })
  return loginShellPath
}

function isExecutable(candidate: string) {
  try {
    accessSync(/*turbopackIgnore: true*/ candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * npm installs a Windows command as a `.cmd` batch shim, which Node cannot
 * spawn without a shell. The shim names its real target relative to `%dp0%`
 * (its own folder): a native `.exe` or a `.js` entry script, which the Agent SDK
 * runs with Node. Return that target.
 */
function resolveWindowsShim(shim: string) {
  let text: string
  try {
    text = readFileSync(/*turbopackIgnore: true*/ shim, 'utf8')
  } catch {
    return undefined
  }
  for (const match of text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:exe|js|cjs|mjs))"/gi)) {
    // npm shims also probe for a bundled `node.exe`; that is the runtime, not the command.
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

/** Absolute path of an executable, looked up in this process's PATH and then the login shell's. */
export async function findExecutable(name: string): Promise<string | undefined> {
  return searchPath(name, process.env.PATH ?? '') ?? searchPath(name, await readLoginShellPath())
}

/**
 * Busyboy's own variables, which must never reach an agent or the commands it
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
 * this process's environment without busyboy's own variables, with the
 * login-shell PATH appended.
 */
export async function agentEnvironment(): Promise<Record<string, string>> {
  const shellPath = await readLoginShellPath()
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isServerVariable(name)) env[name] = value
  }
  const entries = new Set([...(process.env.PATH ?? '').split(delimiter), ...shellPath.split(delimiter)])
  entries.delete('')
  env.PATH = [...entries].join(delimiter)
  return env
}
