import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TEST_REMEMBER_ROOT } from '@/server/records/remember-record'
import { recordDirectory, repoSegments } from '@/server/records/record-path'

// Must match src/server/tasks.ts.
const TASKS_FILE = 'task-list.json'
const WORKTREES_FOLDER = 'task-worktrees'

const FIXTURES = join(__dirname, '..', 'fixtures', 'records')

type RecordTask = { project: string; projectPath: string; id: string; title: string; files?: Record<string, string> }

/** The task's folder in this journey's record root, the stand-in for `~/.jwn/<owner>/<name>/<task>`. */
export async function homeRecordFolder(home: string, task: { id: string; project: string; worktree: string }) {
  const folder = recordDirectory(join(home, TEST_REMEMBER_ROOT), await repoSegments(task), task.id)
  if (!folder) throw new Error(`No record folder for ${task.project}/${task.id}.`)
  return folder
}

/**
 * Adds a task the way busyboy stores one (a git worktree on its own branch and
 * an entry in the task list) with records in the journey's jwn record root.
 * It has no agent, so only its records decide its status. `files` replaces the
 * fixture directory `tests/fixtures/records/<id>/`.
 */
export async function addRecordTask(home: string, { project, projectPath, id, title, files }: RecordTask) {
  const worktree = join(home, WORKTREES_FOLDER, project, id)
  const branch = `busyboy/${id}`
  mkdirSync(dirname(worktree), { recursive: true })
  execFileSync('git', ['-C', projectPath, 'worktree', 'add', '-q', '-b', branch, '--', worktree, 'HEAD'], { stdio: 'ignore' })
  const records = await homeRecordFolder(home, { id, project, worktree })
  mkdirSync(records, { recursive: true })
  if (files) {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(records, name), text)
  } else {
    cpSync(join(FIXTURES, id), records, { recursive: true })
  }

  const file = join(home, TASKS_FILE)
  const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { tasks: unknown[] }) : { tasks: [] }
  list.tasks.push({
    id,
    project,
    title,
    request: title,
    provider: 'claude',
    // No agent has this id, so the runner reports it as stopped.
    agentId: `no-agent-${id}`,
    sessionId: null,
    worktree,
    branch,
    createdAt: new Date(list.tasks.length * 1000).toISOString(),
  })
  writeFileSync(file, `${JSON.stringify({ version: 1, ...list }, null, 2)}\n`)
  return { worktree, records }
}
