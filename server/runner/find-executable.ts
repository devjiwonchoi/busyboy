import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

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

function searchPath(name: string, pathValue: string) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      try {
        accessSync(/*turbopackIgnore: true*/ candidate, constants.X_OK)
        return candidate
      } catch {}
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
