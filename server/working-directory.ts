import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { SERVER_TOKEN_ENV } from '@/lib/server-token'

/**
 * When set to `1`, journeys may choose the working directory with a `cwd`
 * search parameter and the shell with BUSYBOY_TEST_SHELL. Ignored whenever the
 * server has a launch token, which the desktop app always sets.
 */
export const TEST_MODE_ENV = 'BUSYBOY_TEST_MODE'

export function isTestMode() {
  return process.env[TEST_MODE_ENV] === '1' && !process.env[SERVER_TOKEN_ENV]
}

function isDirectory(path: string) {
  return existsSync(path) && statSync(path).isDirectory()
}

/**
 * The folder that terminals and other per-task tools open in. Today it is the
 * user's home directory; once tasks exist it becomes the current task's
 * worktree. Under BUSYBOY_TEST_MODE=1 a journey may pass its own folder.
 */
export function currentWorkingDirectory(options: { testOverride?: string | null } = {}): string {
  const override = options.testOverride
  if (override && isTestMode() && isAbsolute(override) && isDirectory(override)) {
    return override
  }
  return homedir()
}
