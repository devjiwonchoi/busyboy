import { lstat } from 'node:fs/promises'
import { rememberRoot } from './remember-root'
import { recordDirectory, repoSegments, type RecordTask } from './record-path'


export type LocatedRecords = { folder: string } | { error: string } | null

export async function taskRecordDirectory(dataFolder: string, task: RecordTask): Promise<string | { error: string }> {
  const folder = recordDirectory(rememberRoot(dataFolder), await repoSegments(task), task.id)
  return folder ?? { error: 'The record folder would leave the jwn record root.' }
}

// A symbolic link is an error: it could point anywhere.
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
