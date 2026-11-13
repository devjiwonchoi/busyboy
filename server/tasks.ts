import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { dataFolder } from './config'
import { getProject, listProjects } from './projects'
import { defaultProvider } from './providers'
import { getAgent, sendMessage, startAgent, subscribeToAgent } from './runner/agent-runner'
import type { AgentStatus, ProviderId } from './runner/contract'

// A task is one request in one project, worked on by its own agent in its own
// git worktree. The list lives in TASKS_FILE; worktrees live under
// WORKTREES_FOLDER. Both names are new, so the legacy app's `worktrees/` and
// other files in the data folder are never touched.

export const TASKS_FILE = 'task-list.json'
export const WORKTREES_FOLDER = 'task-worktrees'

export type TaskRecord = {
  id: string
  project: string
  title: string
  request: string
  provider: ProviderId
  agentId: string
  /** Set once the provider reports it; used to resume the agent later. */
  sessionId: string | null
  worktree: string
  branch: string
  createdAt: string
}

/** `idle`: the agent finished its turn and waits for a message. `stopped`: its process is gone. */
export type TaskStatus = 'running' | 'needs-you' | 'idle' | 'stopped'

export type TaskView = Pick<TaskRecord, 'id' | 'project' | 'title' | 'branch' | 'createdAt'> & { status: TaskStatus }

export class TaskError extends Error {}

const run = promisify(execFile)

/** The instructions every task agent gets in addition to its provider's own. */
export function taskInstructions(task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'branch'>) {
  return [
    `You are a busyboy task agent for the project "${task.project}".`,
    `You work in the git worktree ${task.worktree} on the branch ${task.branch}. Stay inside this worktree.`,
    'Plan the task with the `align` skill before you change anything, and follow the plan once it is approved.',
    `Keep every record of this task (the plan and any status, verify, or review notes your skills write) under .jwn/${task.id}/ in this worktree.`,
  ].join('\n')
}

// ---- Task list file ----------------------------------------------------------

const QUEUE_KEY = Symbol.for('busyboy.task-list-writes')
const LISTENERS_KEY = Symbol.for('busyboy.task-listeners')
const globalStore = globalThis as typeof globalThis & {
  [QUEUE_KEY]?: Map<string, Promise<unknown>>
  [LISTENERS_KEY]?: Map<string, Set<(task: TaskView) => void>>
}
const writeQueues = (globalStore[QUEUE_KEY] ??= new Map())
const listeners = (globalStore[LISTENERS_KEY] ??= new Map())

async function readTasksAt(folder: string): Promise<TaskRecord[]> {
  try {
    const value = JSON.parse(await readFile(join(folder, TASKS_FILE), 'utf8')) as { tasks?: TaskRecord[] }
    return Array.isArray(value.tasks) ? value.tasks : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Applies `change` to the task list in `folder`, one update at a time. */
function updateTasksAt<T>(folder: string, change: (tasks: TaskRecord[]) => T): Promise<T> {
  const file = join(folder, TASKS_FILE)
  const next = (writeQueues.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const tasks = await readTasksAt(folder)
      const result = change(tasks)
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`)
      await rename(temporary, file)
      return result
    })
  writeQueues.set(file, next)
  return next
}

// ---- Status ------------------------------------------------------------------

function statusOf(agentStatus: AgentStatus | undefined): TaskStatus {
  switch (agentStatus) {
    case 'starting':
    case 'running':
      return 'running'
    case 'waiting':
      return 'needs-you'
    case 'idle':
      return 'idle'
    default:
      return 'stopped'
  }
}

export function taskView(task: TaskRecord): TaskView {
  const { id, project, title, branch, createdAt } = task
  return { id, project, title, branch, createdAt, status: statusOf(getAgent(task.agentId)?.status) }
}

/** Calls `listener` whenever a task in `folder` is created or changes status. */
export function subscribeToTasks(folder: string, listener: (task: TaskView) => void) {
  let set = listeners.get(folder)
  if (!set) listeners.set(folder, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

function notify(folder: string, task: TaskRecord) {
  const view = taskView(task)
  for (const listener of listeners.get(folder) ?? []) listener(view)
}

// ---- Operations --------------------------------------------------------------

export async function listTasksAt(folder: string): Promise<TaskView[]> {
  return (await readTasksAt(folder)).map(taskView)
}

export async function listTasks() {
  return listTasksAt(await dataFolder())
}

function slug(text: string) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  )
}

async function git(cwd: string, ...args: string[]) {
  try {
    return (await run('git', ['-C', cwd, ...args])).stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new TaskError(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

export type CreateTaskInput = { project: string; title: string; request: string; provider?: ProviderId }

/**
 * Makes a worktree on a new branch from the project's current HEAD and starts
 * a task agent there with the request as its first message.
 */
export async function createTask(input: CreateTaskInput): Promise<TaskView> {
  const folder = await dataFolder()
  const title = input.title.trim()
  const request = input.request.trim()
  if (!title) throw new TaskError('Give the task a short title.')
  if (!request) throw new TaskError('Give the task the request to work on.')
  const project = await getProject(input.project.trim().replace(/^@/, ''))
  if (!project) {
    const names = (await listProjects()).map(({ name }) => name).join(', ')
    throw new TaskError(`There is no project named "${input.project}". Projects: ${names || 'none'}.`)
  }
  const provider = input.provider ?? (await defaultProvider())
  if (!provider) throw new TaskError('No provider is signed in. The user can sign in from Setup.')

  const head = await git(project.path, 'rev-parse', '--verify', 'HEAD^{commit}').catch(() => {
    throw new TaskError(`${project.name} has no commits yet, so there is nothing to branch from.`)
  })
  const id = `${slug(title)}-${randomBytes(3).toString('hex')}`
  const branch = `busyboy/${id}`
  const worktree = join(folder, WORKTREES_FOLDER, project.name, id)
  await mkdir(dirname(worktree), { recursive: true })
  await git(project.path, 'worktree', 'add', '-b', branch, '--', worktree, head)

  const agent = startAgent({ provider, cwd: worktree, instructions: taskInstructions({ id, project: project.name, worktree, branch }) })
  const task: TaskRecord = {
    id,
    project: project.name,
    title,
    request,
    provider,
    agentId: agent.id,
    sessionId: null,
    worktree,
    branch,
    createdAt: new Date().toISOString(),
  }
  await updateTasksAt(folder, (tasks) => void tasks.push(task))
  watchAgent(folder, task)
  sendMessage(agent.id, request)
  notify(folder, task)
  return taskView(task)
}

/** Saves the session id when it arrives and reports status changes. */
function watchAgent(folder: string, task: TaskRecord) {
  let last = taskView(task).status
  subscribeToAgent(task.agentId, 0, ({ event }) => {
    if (event.type === 'session' && event.sessionId !== task.sessionId) {
      task.sessionId = event.sessionId
      void updateTasksAt(folder, (tasks) => {
        const stored = tasks.find(({ id }) => id === task.id)
        if (stored) stored.sessionId = event.sessionId
      })
    }
    // The runner updates its status before it delivers the event.
    const status = taskView(task).status
    if (status !== last) {
      last = status
      notify(folder, task)
    }
  })
}
