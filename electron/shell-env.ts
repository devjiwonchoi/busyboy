import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'

const MARKER = '__BUSYBOY_PATH__'
const TIMEOUT_MS = 5000

export type ShellPathResult = {
  source: 'login-shell' | 'process'
  entries: number
  error?: string
}

function readLoginShellPath(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      { timeout: TIMEOUT_MS, encoding: 'utf8', env: process.env },
      (error, stdout) => {
        const match = stdout?.match(new RegExp(`${MARKER}(.*)${MARKER}`, 's'))
        if (match?.[1]) resolve(match[1].trim())
        else reject(error ?? new Error('The login shell printed no PATH.'))
      },
    )
  })
}

function mergePaths(...values: Array<string | undefined>) {
  const seen = new Set<string>()
  for (const value of values) {
    for (const entry of value?.split(delimiter) ?? []) {
      if (entry) seen.add(entry)
    }
  }
  return [...seen].join(delimiter)
}

/**
 * Apps opened from Finder or the Dock get launchd's minimal PATH, so spawning
 * `claude`, `codex`, or `git` by name fails. Read the PATH the user's login
 * shell sets up and put it first in this process's PATH, which the server and
 * every agent it spawns inherit.
 */
export async function installLoginShellPath(): Promise<ShellPathResult> {
  if (process.platform === 'win32') {
    return { source: 'process', entries: (process.env.PATH ?? '').split(delimiter).filter(Boolean).length }
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  try {
    const shellPath = await readLoginShellPath(shell)
    process.env.PATH = mergePaths(shellPath, process.env.PATH)
    return { source: 'login-shell', entries: process.env.PATH.split(delimiter).length }
  } catch (error) {
    return {
      source: 'process',
      entries: (process.env.PATH ?? '').split(delimiter).filter(Boolean).length,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
