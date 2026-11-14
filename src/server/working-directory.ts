import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { SERVER_TOKEN_ENV, TEST_MODE_ENV } from '@/lib/server-token'
import { dataFolder } from './config'
import { readTasksAt, TaskError, WORKTREES_FOLDER, type TaskRecord } from './tasks'

/**
 * In test mode a journey may choose the working directory (the panel sends
 * the page's `cwd` search parameter when it starts a terminal) and the shell
 * (BUSYBOY_TEST_SHELL). Never while the server has a launch token, which the
 * desktop app always sets.
 */
export function isTestMode() {
  return process.env[TEST_MODE_ENV] === '1' && !process.env[SERVER_TOKEN_ENV]
}

function isDirectory(path: string) {
  return existsSync(path) && statSync(path).isDirectory()
}

export type WorkingDirectory = { cwd: string; task: Pick<TaskRecord, 'id' | 'project' | 'title'> | null }

/**
 * The folder that terminals and other per-task tools open in: the worktree of
 * the task the user selected, or the home directory when none is selected.
 *
 * The client names a task, never a folder, and the worktree comes from
 * BusyBoy's own task list. It must also be exactly the folder BusyBoy makes
 * for that task (`task-worktrees/<project>/<id>` in the data folder), so an
 * edited task list cannot point a shell anywhere else. Under
 * BUSYBOY_TEST_MODE=1 a journey may pass its own folder instead.
 *
 * Failures are TaskErrors with a line for the user, never a raw 500.
 */
export async function currentWorkingDirectory({
  taskId,
  testOverride,
}: {
  taskId: string | null
  testOverride: string | null
}): Promise<WorkingDirectory> {
  if (testOverride && isTestMode() && isAbsolute(testOverride) && isDirectory(testOverride)) {
    return { cwd: testOverride, task: null }
  }
  if (!taskId) {
    return { cwd: homedir(), task: null }
  }

  const folder = await dataFolder()
  const tasks = await readTasksAt(folder).catch((error: unknown) => {
    throw new TaskError(`The task list could not be read: ${error instanceof Error ? error.message : String(error)}`)
  })
  const task = tasks.find(({ id }) => id === taskId)
  if (!task) {
    throw new TaskError('That task no longer exists.')
  }
  if (!isDirectory(task.worktree)) {
    throw new TaskError(`The worktree of "${task.title}" is gone: ${task.worktree}`)
  }

  // Compared after resolving symlinks, so a link inside the worktrees folder cannot lead out of
  // it, and the shell starts in the resolved folder that passed the check. Only the worktrees
  // folder itself is resolved on the expected side: a link put in the task's own place must fail.
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
  const worktree = real(task.worktree)
  // A project or id of `..` would let join() climb out of the worktrees folder.
  const isSegment = (name: string) => basename(name) === name && name !== '.' && name !== '..'
  const worktrees = real(join(folder, WORKTREES_FOLDER))
  const inPlace = isSegment(task.project) && isSegment(task.id) && worktrees !== null
  // Only compared, never opened, so Turbopack need not trace it; without the ignore comment it
  // traces the whole project for a path built at run time.
  if (!worktree || !inPlace || worktree !== join(/*turbopackIgnore: true*/ worktrees, task.project, task.id)) {
    throw new TaskError(`The worktree of "${task.title}" is not one of BusyBoy's task worktrees.`)
  }

  return { cwd: worktree, task: { id: task.id, project: task.project, title: task.title } }
}
