import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { containsPath } from '../paths'

// The path shape is the task-recording skill's. Test mode uses a folder under the journey's data folder.

const run = promisify(execFile)

export type RecordTask = { id: string; project: string; worktree: string }

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

export function repositoryDirectory(root: string, segments: string[]): string | null {
  if (segments.length === 0 || segments.some((part) => !safeSegment(part))) return null
  const folder = join(/*turbopackIgnore: true*/ root, ...segments)
  return containsPath(root, folder) && folder !== root ? folder : null
}

export function recordDirectory(root: string, segments: string[], taskId: string): string | null {
  const repository = repositoryDirectory(root, segments)
  if (!repository || !safeSegment(taskId)) return null
  const folder = join(/*turbopackIgnore: true*/ repository, taskId)
  return containsPath(repository, folder) ? folder : null
}
