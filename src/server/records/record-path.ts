import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { containsPath } from '../paths'

// Where a task's records live, as the task-recording skill defines it.
// The root is `$JWN_HOME` or `~/.jwn` (rememberRoot picks that, and in test
// mode a folder under the journey's data folder). Under the root, a task is
// `<owner>/<name>/<task>` when `origin` is `https://host/owner/name` or
// `git@host:owner/name`. When origin cannot be read, the folder is the
// basename of the git directory's parent. Outside a checkout it is the
// project name. One segment in that last case, not owner/name.

const run = promisify(execFile)

export type RecordTask = { id: string; project: string; worktree: string }

/** `owner` and `name` from an origin URL, or null when the URL has no such pair. */
export function repoFromOrigin(url: string): string[] | null {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!cleaned) return null
  let path = cleaned
  const scp = /^[^/\s]+@[^:\s]+:(.+)$/.exec(cleaned)
  if (scp) path = scp[1]
  else if (cleaned.includes('://')) {
    try {
      path = new URL(cleaned).pathname
    } catch {
      return null
    }
  }
  const parts = path.split('/').filter(Boolean).slice(-2)
  if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..')) return null
  return parts
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 3_000, windowsHide: true, killSignal: 'SIGKILL' })
  return stdout.trim()
}

/**
 * The path segments under the record root for this checkout: `[owner, name]`
 * from origin, otherwise one segment, the repository directory or the project name.
 */
export async function repoSegments(task: Pick<RecordTask, 'project' | 'worktree'>): Promise<string[]> {
  try {
    const fromOrigin = repoFromOrigin(await git(task.worktree, 'remote', 'get-url', 'origin'))
    if (fromOrigin) return fromOrigin
  } catch {
    // No origin, or git could not be run. The directory name is the next try.
  }
  try {
    const common = await git(task.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const name = basename(dirname(common))
    if (name && name !== '.' && name !== '..') return [name]
  } catch {
    // Not a git checkout.
  }
  return [task.project?.trim() || 'task']
}

const safeSegment = (part: string) => part.length > 0 && part !== '.' && part !== '..' && !part.includes('/') && !part.includes('\\') && !part.includes('\0')

/** `<root>/<segments>`, the repository's folder of task records, or null when that path would leave the root. */
export function repositoryDirectory(root: string, segments: string[]): string | null {
  if (segments.length === 0 || segments.some((part) => !safeSegment(part))) return null
  const folder = join(/*turbopackIgnore: true*/ root, ...segments)
  return containsPath(root, folder) && folder !== root ? folder : null
}

/** `<root>/<segments>/<task id>`, or null when that path would leave the root. */
export function recordDirectory(root: string, segments: string[], taskId: string): string | null {
  const repository = repositoryDirectory(root, segments)
  if (!repository || !safeSegment(taskId)) return null
  const folder = join(/*turbopackIgnore: true*/ repository, taskId)
  return containsPath(repository, folder) ? folder : null
}
