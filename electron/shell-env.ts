import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'

const MARKER = '__BUSYBOY_PATH__'
const TIMEOUT_MS = 5000

export type ShellPathResult = {
  source: 'login-shell' | 'process'
  entries: number
  error?: string
}

/**
 * Runs the login shell in its own process group. On timeout the whole group is
 * killed and the promise settles without waiting for stdout to close, so a
 * grandchild that keeps the pipe open cannot block startup.
 */
function readLoginShellPath(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    })
    let stdout = ''
    let settled = false

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const settle = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup()
      child.stdout.destroy()
      const match = stdout.match(new RegExp(`${MARKER}(.*)${MARKER}`, 's'))
      if (!error && match?.[1]) resolve(match[1].trim())
      else reject(error ?? new Error('The login shell printed no PATH.'))
    }

    const timer = setTimeout(() => settle(new Error(`The login shell did not answer within ${TIMEOUT_MS} ms.`)), TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      // Done as soon as the closing marker arrives, even if the pipe stays open.
      if (stdout.split(MARKER).length >= 3) settle(null)
    })
    child.once('error', (error) => settle(error))
    child.stdout.once('close', () => settle(null))
    // A grandchild may keep stdout open after the shell exits; give the pipe a moment, then stop waiting.
    child.once('exit', () => setTimeout(() => settle(null), 250))
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
