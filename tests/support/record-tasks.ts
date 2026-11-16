import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Must match src/server/tasks.ts.
const TASKS_FILE = 'task-list.json'
const WORKTREES_FOLDER = 'task-worktrees'

const FIXTURES = join(__dirname, '..', 'fixtures', 'records')

type RecordTask = { project: string; projectPath: string; id: string; title: string }

/**
 * Adds a task the way busyboy stores one (a git worktree on its own branch and
 * an entry in the task list) with the records of `tests/fixtures/records/<id>/`
 * under `.jwn/<id>/`. It has no agent, so only its records decide its status.
 */
export function addRecordTask(home: string, { project, projectPath, id, title }: RecordTask) {
  const worktree = join(home, WORKTREES_FOLDER, project, id)
  const branch = `busyboy/${id}`
  mkdirSync(dirname(worktree), { recursive: true })
  execFileSync('git', ['-C', projectPath, 'worktree', 'add', '-q', '-b', branch, '--', worktree, 'HEAD'], { stdio: 'ignore' })
  const records = join(worktree, '.jwn', id)
  cpSync(join(FIXTURES, id), records, { recursive: true })

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
