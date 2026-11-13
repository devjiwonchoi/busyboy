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

/** The environment agents run with: this process's, with the login-shell PATH appended. */
export async function agentEnvironment(): Promise<NodeJS.ProcessEnv> {
  const shellPath = await readLoginShellPath()
  const entries = new Set([...(process.env.PATH ?? '').split(delimiter), ...shellPath.split(delimiter)])
  entries.delete('')
  return { ...process.env, PATH: [...entries].join(delimiter) }
}
