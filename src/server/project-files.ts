import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getProject } from './projects'

const run = promisify(execFile)

/** Enough for the picker to filter. A larger tree still matches by the names that fit. */
const MAX_FILES = 2_000

export type ProjectFile = { path: string }

/** Files git tracks in `project`, relative to the repository root. */
export async function listProjectFiles(project: string): Promise<ProjectFile[]> {
  const found = await getProject(project)
  if (!found) return []
  try {
    const { stdout } = await run('git', ['-C', found.path, 'ls-files', '-z'], { maxBuffer: 8 * 1024 * 1024 })
    return stdout
      .split('\0')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_FILES)
      .map((path) => ({ path }))
  } catch {
    return []
  }
}
