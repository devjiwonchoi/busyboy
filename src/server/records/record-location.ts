import { lstat } from 'node:fs/promises'
import { rememberRoot } from './remember-root'
import { recordDirectory, repoSegments, type RecordTask } from './record-path'

// The only place task records are read from: the home record root, at
// `<root>/<owner>/<name>/<task>/`. The in-project `.jwn/<task>/` folder is not read.

export type LocatedRecords = { folder: string } | { error: string } | null

/** The task's record directory, whether or not it exists yet. An error when the path would leave the root. */
export async function taskRecordDirectory(dataFolder: string, task: RecordTask): Promise<string | { error: string }> {
  const folder = recordDirectory(rememberRoot(dataFolder), await repoSegments(task), task.id)
  return folder ?? { error: 'The record folder would leave the jwn record root.' }
}

/**
 * The task's record folder when it exists and is a real directory.
 * Null when the task has no records yet. A symbolic link is an error: it could point anywhere.
 */
export async function locateTaskRecords(dataFolder: string, task: RecordTask): Promise<LocatedRecords> {
  const directory = await taskRecordDirectory(dataFolder, task)
  if (typeof directory !== 'string') return directory
  try {
    const stats = await lstat(directory)
    if (stats.isSymbolicLink()) return { error: 'The record folder is a symbolic link.' }
    if (!stats.isDirectory()) return { error: 'The record path is not a folder.' }
    return { folder: directory }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    return { error: code ?? String(error) }
  }
}
