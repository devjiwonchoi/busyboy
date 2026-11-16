import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { alwaysAskRulesAt } from './always-ask-list'
import { dataFolder } from './config'
import { REVERT_AND_REMEMBER } from './director/context'
import { memoryPrompt } from './memory'
import { getProject, listProjects } from './projects'
import { defaultProvider } from './providers'
import {
  getAgent,
  isLostSessionError,
  isStoppingAllAgents,
  sendMessage,
  startAgent,
  stopAgent,
  subscribeToAgent,
} from './runner/agent-runner'
import { agentEnvironment } from './runner/find-executable'
import { APPROVE_MESSAGE, hasOpenCard, stopTaskAgent, trackTaskCards } from './task-cards'
import type { AgentEvent, AgentStatus, McpServer, ProviderId } from './runner/contract'

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
  /**
   * The agent's last status, kept across restarts: a task that was running or
   * waiting when the server stopped or died resumes on the next start. A stop
   * made by the server itself is not saved, so quitting keeps it.
   */
  activity?: TaskStatus
  /** Why the task stopped when it could not resume, shown with the task. */
  note?: string | null
}

/** `idle`: the agent finished its turn and waits for a message. `stopped`: its process is gone. */
export type TaskStatus = 'running' | 'needs-you' | 'idle' | 'stopped'

export type TaskView = Pick<TaskRecord, 'id' | 'project' | 'title' | 'branch' | 'createdAt'> & { status: TaskStatus; note: string | null }

export class TaskError extends Error {}

const run = promisify(execFile)

/** The instructions every task agent gets in addition to its provider's own. */
export function taskInstructions(task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'branch'>, alwaysAsk: string[]) {
  return [
    `You are a busyboy task agent for the project "${task.project}".`,
    `You work in the git worktree ${task.worktree} on the branch ${task.branch}. Stay inside this worktree.`,
    'Plan the task with the `align` skill before you change anything, and follow the plan once it is approved.',
    `Keep every record of this task (the plan and any status, verify, or review notes your skills write) under .jwn/${task.id}/ in this worktree.`,
    '',
    'Approval:',
    // BusyBoy turns a draft ALIGN.md at the end of a turn into the user's Align card, so the
    // plan must be on disk before the agent waits; the align skill alone saves it only after approval.
    `- When the plan is ready for approval, save it as .jwn/${task.id}/ALIGN.md with "Status: draft", present it, and end your turn. BusyBoy shows it to the user as a plan card.`,
    `- The message "${APPROVE_MESSAGE}" approves the plan as saved: change its Status line to approved and carry on. Any other reply asks for changes; revise the draft and end your turn again.`,
    '- Do reversible actions without asking, then say what you did. Ask before irreversible ones.',
    // The hooks enforce the list; telling the agent lets it plan for the wait instead of being
    // refused mid-task. Knowing the rules does not help an agent get around them: the matcher
    // reads commands through wrappers and quoting and asks when it cannot tell.
    ...(alwaysAsk.length > 0
      ? [
          '- BusyBoy asks the user before every tool call that matches one of these rules, even when the plan approved it, so expect to wait for an answer there:',
          ...alwaysAsk.map((rule) => `  - ${rule}`),
        ]
      : []),
    '',
    'Memory:',
    '- The Memory section below is what BusyBoy remembers about the user and this project. Follow it.',
    `- Save what later tasks in ${task.project} need (a user preference, a convention of this project) with the busyboy memory_write tool as soon as you learn it. Your writes always go to this project's memory.`,
    '- When the task ends, add one memory_write line with kind "log" saying what was done and where.',
    REVERT_AND_REMEMBER,
  ].join('\n')
}

/** A task agent's system prompt: its instructions, then the global and project facts. */
async function taskPrompt(folder: string, task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'branch'>, alwaysAsk: string[]) {
  return `${taskInstructions(task, alwaysAsk)}\n\n${await memoryPrompt(folder, { project: task.project })}`
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

export async function readTasksAt(folder: string): Promise<TaskRecord[]> {
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
  const agent = getAgent(task.agentId)
  // An idle task is not resumed at start (see resumeTasks); it shows as idle, not stopped.
  const status = !agent && task.activity === 'idle' ? 'idle' : statusOf(agent?.status)
  // A plan card waits on the user while the agent itself is idle, between turns.
  return {
    id,
    project,
    title,
    branch,
    createdAt,
    status: status === 'idle' && hasOpenCard(task.agentId) ? 'needs-you' : status,
    note: task.note ?? null,
  }
}

/** Calls `listener` whenever a task in `folder` is created or changes status. */
export function subscribeToTasks(folder: string, listener: (task: TaskView) => void) {
  // Whatever shows tasks (the window, the tray) is the first sign the data folder is in use.
  void resumeTasks(folder)
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
  void resumeTasks(folder)
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

/** Runs git with the agent environment, so repository hooks never see busyboy's own variables. */
async function git(cwd: string, ...args: string[]) {
  try {
    // Next.js types NODE_ENV as required on ProcessEnv; the agent environment drops it on purpose.
    const env = agentEnvironment() as NodeJS.ProcessEnv
    return (await run('git', ['-C', cwd, ...args], { env })).stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new TaskError(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

export type CreateTaskInput = {
  project: string
  title: string
  request: string
  provider?: ProviderId
  /** Busyboy's MCP endpoint for this task's agent (memory tools), given the project's stored name. */
  taskMcp?: (project: string) => Promise<Record<string, McpServer>>
}

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
  // Settings can be edited by hand, and the name becomes a folder below; a name with a path in it
  // would put the worktree outside the data folder.
  if (/[/\\]/.test(project.name) || /^\.+$/.test(project.name)) {
    throw new TaskError(`"${project.name}" cannot be used as a folder name. Rename the project in Setup.`)
  }
  const provider = input.provider ?? (await defaultProvider())
  if (!provider) throw new TaskError('No provider is signed in. The user can sign in from Setup.')

  const head = await git(project.path, 'rev-parse', '--verify', 'HEAD^{commit}').catch((error: TaskError) => {
    if (/Needed a single revision|unknown revision/.test(error.message)) {
      throw new TaskError(`${project.name} has no commits yet, so there is nothing to branch from.`)
    }
    throw new TaskError(`${project.name} cannot be read as a git repository: ${error.message}`)
  })
  const id = `${slug(title)}-${randomBytes(3).toString('hex')}`
  const branch = `busyboy/${id}`
  const worktree = join(folder, WORKTREES_FOLDER, project.name, id)
  await mkdir(dirname(worktree), { recursive: true })
  await git(project.path, 'worktree', 'add', '-b', branch, '--', worktree, head)

  let agentId: string | undefined
  try {
    const alwaysAsk = await alwaysAskRulesAt(folder)
    const agent = startAgent({
      provider,
      cwd: worktree,
      instructions: await taskPrompt(folder, { id, project: project.name, worktree, branch }, alwaysAsk),
      mcpServers: input.taskMcp ? await input.taskMcp(project.name) : undefined,
      alwaysAsk,
    })
    agentId = agent.id
    if (getAgent(agent.id)?.status === 'stopped') throw new TaskError(`The task agent could not start: ${startError(agent.id)}`)
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
      activity: 'running',
    }
    await updateTasksAt(folder, (tasks) => void tasks.push(task))
    watchAgent(folder, task)
    sendMessage(agent.id, request)
    notify(folder, task)
    return taskView(task)
  } catch (error) {
    // Leave nothing behind for a task whose agent failed at once.
    if (agentId) await stopAgent(agentId).catch(() => {})
    await git(project.path, 'worktree', 'remove', '--force', '--', worktree).catch(() => {})
    await git(project.path, 'branch', '-D', '--', branch).catch(() => {})
    await updateTasksAt(folder, (tasks) => void tasks.splice(0, tasks.length, ...tasks.filter((task) => task.id !== id))).catch(
      () => {},
    )
    if (error instanceof TaskError) throw error
    // The agent stopped while the task was being saved: report its own error.
    if (agentId && getAgent(agentId)?.status === 'stopped') throw new TaskError(`The task agent could not start: ${startError(agentId)}`)
    throw new TaskError(`The task could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Whether the agent already reported that its provider cannot run (Claude reports a missing CLI while starting). */
function startFailedAlready(agentId: string) {
  let failed = false
  subscribeToAgent(agentId, 0, ({ event }) => {
    if (event.type === 'error' && isStartFailure(event)) failed = true
  })?.()
  return failed
}

/** The error a task agent reported while starting. */
function startError(agentId: string) {
  let message = 'unknown error'
  subscribeToAgent(agentId, 0, ({ event }) => {
    if (event.type === 'error') message = event.message
  })?.()
  return message
}

/** Applies `change` to the stored copy of `task` and to `task` itself. */
function saveTask(folder: string, task: TaskRecord, change: Partial<TaskRecord>) {
  Object.assign(task, change)
  return updateTasksAt(folder, (tasks) => {
    const stored = tasks.find(({ id }) => id === task.id)
    if (stored) Object.assign(stored, change)
  }).catch((error: unknown) => console.error(`busyboy: could not save task ${task.id}`, error))
}

/**
 * Saves the session id when it arrives, keeps the task's activity for resume,
 * and reports status changes. A resumed agent whose session turns out to be
 * gone stops the task with a note.
 */
function watchAgent(folder: string, task: TaskRecord, { resumed = false, fromRestart = false } = {}) {
  let last = taskView(task).status
  let confirmed = !resumed
  // Until its first turn ends well, a restarted agent may still find its provider
  // unusable: Claude reports signed-out only inside its first reply, after the session.
  let checkingStart = fromRestart
  let startFailed = false
  const report = () => {
    const status = taskView(task).status
    if (status !== last) {
      last = status
      // Agents the server stops on its way down, and restarted agents whose provider
      // could not start (not installed, signed out), keep their activity and resume
      // on the next start.
      const keep = startFailed || (status === 'stopped' && isStoppingAllAgents())
      if (!keep) void saveTask(folder, task, { activity: status })
      notify(folder, task)
    }
  }
  trackTaskCards({ folder, task, onChange: report })
  subscribeToAgent(task.agentId, 0, ({ event }) => {
    if (event.type === 'session') {
      confirmed = true
      if (event.sessionId !== task.sessionId) void saveTask(folder, task, { sessionId: event.sessionId })
    }
    // Only a session the provider no longer has is a failed resume. Other
    // errors (an MCP server that did not start) leave a working agent, and
    // Claude confirms a resumed session only with its first reply, so an idle
    // resumed agent can stay unconfirmed for a long time.
    if (event.type === 'error' && !confirmed && isLostSessionError(event)) {
      confirmed = true
      void saveTask(folder, task, {
        activity: 'stopped',
        note: resumeNote('the provider no longer has its conversation'),
      }).then(() => notify(folder, task))
      // A lost session never recovers; stop now instead of waiting for the process.
      void stopAgent(task.agentId).catch(() => {})
      last = 'stopped'
      return
    }
    if (event.type === 'error' && checkingStart && !startFailed && isStartFailure(event)) {
      startFailed = true
      void saveTask(folder, task, { note: resumeNote(`${event.message} It is tried again the next time BusyBoy starts`) })
      // The provider cannot work until the user fixes it; end the process instead of leaving it idle.
      void stopAgent(task.agentId).catch(() => {})
    }
    if (event.type === 'turn-done') checkingStart = false
    // The runner updates its status before it delivers the event.
    report()
  })
}

/** The provider cannot run at all yet; the user can fix it (install, sign in) before the next start. */
const isStartFailure = (event: Extract<AgentEvent, { type: 'error' }>) => event.code === 'not-installed' || event.code === 'signed-out'

const resumeNote = (reason: string) => `Could not resume after BusyBoy restarted: ${reason.replace(/\.$/, '')}.`

/** Stops a task's agent. The task, its worktree, and its branch stay. */
export async function stopTask(taskId: string) {
  const folder = await dataFolder()
  const task = (await readTasksAt(folder)).find(({ id }) => id === taskId)
  if (!task) {
    throw new TaskError(`There is no task ${taskId}.`)
  }
  // Saved before the agent stops: a Quit right after would otherwise suppress
  // the save of its stopped event, and the task would resume on the next start.
  await updateTasksAt(folder, (tasks) => {
    const stored = tasks.find(({ id }) => id === taskId)
    if (stored) stored.activity = 'stopped'
  })
  task.activity = 'stopped'
  // A task that was not resumed has no agent to report the stop, so report it here.
  if (!getAgent(task.agentId)) notify(folder, task)
  await stopTaskAgent({ folder, agentId: task.agentId })
}

// ---- Resume after a restart -------------------------------------------------

/**
 * Sent to an agent resumed mid-turn. Its last step may or may not have
 * finished, and only the agent can tell from the worktree, so it checks
 * instead of BusyBoy sending the request again.
 */
export const RESUME_WORKING_MESSAGE =
  'BusyBoy restarted while you were working, so your last step may not have finished. Check what is already done in the worktree before you continue, so nothing runs twice, then carry on with the task.'

/** Sent to an agent resumed while it waited on the user: the open request died with the old process. */
export const RESUME_WAITING_MESSAGE =
  'BusyBoy restarted while you were waiting for the user, and your request to them was lost. Ask them again the same way, and do nothing else until they answer.'

const RESUMES_KEY = Symbol.for('busyboy.task-resumes')
const resumeStore = globalThis as typeof globalThis & { [RESUMES_KEY]?: Map<string, Promise<void>> }
const resumes = (resumeStore[RESUMES_KEY] ??= new Map())

/**
 * Brings back the tasks in `folder` that were running or waiting on the user
 * (a question, an approval, or a plan card) when the server last stopped or
 * died. Runs once per data folder per server process.
 *
 * Idle tasks are left alone: a finished task stays idle for good, and starting
 * a provider process for each of them on every launch would load a small
 * machine for nothing. An idle task keeps its session id and shows as idle.
 * Nothing starts it again yet; the user can stop it.
 */
export function resumeTasks(folder: string): Promise<void> {
  let resume = resumes.get(folder)
  if (!resume) {
    resume = (async () => {
      const tasks = await readTasksAt(folder).catch(() => [] as TaskRecord[])
      for (const listed of tasks) {
        if (isStoppingAllAgents()) return
        // Read again: the user may have stopped this task while earlier ones were resuming.
        const task = (await readTasksAt(folder).catch(() => [] as TaskRecord[])).find(({ id }) => id === listed.id)
        // A live agent belongs to this process already (a dev reload of this module).
        if (!task || getAgent(task.agentId) || (task.activity !== 'running' && task.activity !== 'needs-you')) continue
        await resumeTask(folder, task).catch((error: unknown) => {
          // Shown now, but the activity is kept: a read error may pass, so the next start tries again.
          task.note = resumeNote(error instanceof Error ? error.message : String(error))
          void saveTask(folder, task, { note: task.note })
          notify(folder, task)
        })
      }
    })()
    resumes.set(folder, resume)
  }
  return resume
}

async function resumeTask(folder: string, task: TaskRecord) {
  // Read before the agent starts: its session event updates `task` while this awaits.
  const { activity, sessionId } = task
  try {
    await readFile(join(task.worktree, '.git'))
  } catch {
    // Gone for good, unlike the errors resumeTasks retries on the next start.
    await saveTask(folder, task, { activity: 'stopped', note: resumeNote(`its worktree ${task.worktree} is gone`) })
    notify(folder, task)
    return
  }
  // Read through a dynamic import: mcp-tools creates tasks, so a static import would be circular.
  const { busyboyMcpServers } = await import('./mcp-tools')
  // Read the list again: the user may have edited it while BusyBoy was closed.
  const alwaysAsk = await alwaysAskRulesAt(folder)
  const agent = startAgent({
    provider: task.provider,
    cwd: task.worktree,
    instructions: await taskPrompt(folder, task, alwaysAsk),
    mcpServers: await busyboyMcpServers(task.project, folder),
    resumeSessionId: sessionId ?? undefined,
    alwaysAsk,
  })
  task.agentId = agent.id
  // The adapter threw while starting: shown, and like a missing CLI, tried again on the next start.
  if (getAgent(agent.id)?.status === 'stopped') {
    await saveTask(folder, task, { agentId: agent.id, note: resumeNote(startError(agent.id)) })
    notify(folder, task)
    return
  }
  // Clear the last start's note first: the watcher replays this agent's events
  // at once and may write a new one (a missing CLI). Both writes are queued in order.
  const saved = saveTask(folder, task, { agentId: agent.id, note: null })
  watchAgent(folder, task, { resumed: Boolean(sessionId), fromRestart: true })
  await saved
  notify(folder, task)
  // A lost session or a missing CLI may already have ended the agent; the watcher has noted why.
  if (getAgent(agent.id)?.status === 'stopped' || startFailedAlready(agent.id)) return
  try {
    // No stored session means the provider never took the request, so sending it again runs it once.
    // Claude reports its session with its first reply and the save is queued, so a crash in
    // between can still send the request twice; that window is the length of one file write.
    if (!sessionId) sendMessage(agent.id, task.request)
    else if (activity === 'running') sendMessage(agent.id, RESUME_WORKING_MESSAGE)
    else if (activity === 'needs-you') sendMessage(agent.id, RESUME_WAITING_MESSAGE)
  } catch (error) {
    // It stopped in between; its events already say why.
    console.error(`busyboy: could not message resumed task ${task.id}`, error)
  }
}
