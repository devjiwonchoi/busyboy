import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'

/** When set to `1`, journeys may choose the working directory with a `cwd` search parameter. */
export const TEST_MODE_ENV = 'BUSYBOY_TEST_MODE'

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
  if (override && process.env[TEST_MODE_ENV] === '1' && isAbsolute(override) && isDirectory(override)) {
    return override
  }
  return homedir()
}
