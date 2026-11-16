import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  lastAgentReply,
  removeAgent,
  sendMessage,
  startAgent,
  stopAgent,
  subscribeToAgent,
} from './runner/agent-runner'
import { agentEnvironment } from './runner/find-executable'
import { trackWorkCards } from './cards/work-cards'
import { APPROVE_MESSAGE, hasOpenCard, stopTaskAgent, trackTaskCards } from './task-cards'
import type { AgentEvent, AgentStatus, McpServer, ProviderId, StartAgentInput } from './runner/contract'

// A task is one request in one project, worked on by its own agent in its own
// git worktree. The list lives in TASKS_FILE; worktrees live under
// WORKTREES_FOLDER. Both names are new, so the legacy app's `worktrees/` and
// other files in the data folder are never touched.
//
// A subagent is a task for one short action (merge a PR, check CI, run a command). It runs in
// the project's own checkout with no worktree or branch, asks before anything that could change it, plans nothing,
// and its reply shows in the chat. Anything that changes files is a task.
//
// An archived task is out of the way, not gone: it leaves the project graph and the status
// summary, its agent ends, and its worktree is removed unless it has changed or untracked files.
// Its branch, its provider session, and its records are kept, so restoring it brings those back.
// Files git ignores (installed packages, build output, a local env file) go with the worktree:
// keeping every worktree that has a node_modules would keep nearly all of them.

export const TASKS_FILE = 'task-list.json'
export const WORKTREES_FOLDER = 'task-worktrees'
/** Where an archived task's records wait while its worktree is gone: `<project>/<task>/.jwn`. */
export const ARCHIVE_FOLDER = 'task-archive'
/** The folder in a worktree that holds the task's records (see records/project-graph.ts). */
const RECORDS_FOLDER = '.jwn'

export type TaskRecord = {
  id: string
  project: string
  title: string
  request: string
  provider: ProviderId
  agentId: string
  /** Set once the provider reports it; used to resume the agent later. */
  sessionId: string | null
  /** The task's worktree; a subagent's is the project folder itself. */
  worktree: string
  /** Empty for a subagent. */
  branch: string
  createdAt: string
  kind?: 'subagent'
  /** A subagent's last reply, saved when its turn ends: its result, kept after its process ends. */
  reply?: string | null
  /**
   * The agent's last status, kept across restarts: a task that was running or
   * waiting when the server stopped or died resumes on the next start. A stop
   * made by the server itself is not saved, so quitting keeps it.
   */
  activity?: TaskStatus
  /** Why the task stopped when it could not resume, shown with the task. */
  note?: string | null
  /** Set while the task is archived. */
  archivedAt?: string | null
  /** The manager that created the task, whose chat shows it; unset for the Director's. */
  chat?: string | null
}

/** `idle`: the agent finished its turn and waits for a message. `stopped`: its process is gone. */
export type TaskStatus = 'running' | 'needs-you' | 'idle' | 'stopped'

export type TaskView = Pick<TaskRecord, 'id' | 'project' | 'title' | 'branch' | 'createdAt'> & {
  status: TaskStatus
  note: string | null
  subagent: boolean
  /** A subagent's last reply once it has finished its turn: its result, shown in the chat. */
  reply: string | null
  archived: boolean
  /** The manager whose chat shows the task; null for the Director's. */
  chat: string | null
}

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
    `- Record progress in .jwn/${task.id}/STATUS.md as you go: a State line (running, or done when the task is finished) and a "| Todo | Result |" table whose rows match the plan's todos. BusyBoy shows a progress card from that table, and a one-line done card once State is done.`,
    '- When you open pull requests, add a "# Pull requests" table to that STATUS.md with columns Number, Title, URL, Check, and Review. One row per pull request, in stack order, the base of the stack first. BusyBoy lists them on a card and does not merge them.',
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

/** The instructions a subagent gets in addition to its provider's own. */
export function subagentInstructions(task: Pick<TaskRecord, 'project' | 'worktree'>, alwaysAsk: string[]) {
  return [
    `You are a busyboy subagent for the project "${task.project}", started for one short action such as merging a pull request, checking CI, or running a command.`,
    `You run in the project's own checkout, ${task.worktree}, which the user works in. Do not edit files, switch branches, or change the checkout: BusyBoy asks the user before any tool call that could. If the request needs file changes, stop and say it needs a task.`,
    'Do the action without planning, then reply in one or two sentences with the result. The user sees that reply.',
    ...(alwaysAsk.length > 0
      ? ['BusyBoy asks the user before every tool call that matches one of these rules, so expect to wait for an answer there:', ...alwaysAsk.map((rule) => `- ${rule}`)]
      : []),
  ].join('\n')
}

/** A task agent's system prompt: its instructions, then the global and project facts. */
async function taskPrompt(folder: string, task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'branch' | 'kind'>, alwaysAsk: string[]) {
  const instructions = task.kind === 'subagent' ? subagentInstructions(task, alwaysAsk) : taskInstructions(task, alwaysAsk)
  return `${instructions}\n\n${await memoryPrompt(folder, { project: task.project })}`
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
  // An idle task is not resumed at start (see resumeTasks); it shows as idle, not stopped. A
  // subagent's process ends once it has answered (see watchAgent), and it stays done.
  const ended = !agent || (task.kind === 'subagent' && agent.status === 'stopped')
  const status = ended && task.activity === 'idle' ? 'idle' : statusOf(agent?.status)
  // A plan card waits on the user while the agent itself is idle, between turns.
  return {
    id,
    project,
    title,
    branch,
    createdAt,
    status: status === 'idle' && hasOpenCard(task.agentId) ? 'needs-you' : status,
    note: task.note ?? null,
    subagent: task.kind === 'subagent',
    reply: task.kind === 'subagent' ? (task.reply ?? (status === 'idle' ? lastAgentReply(task.agentId) : null)) : null,
    archived: Boolean(task.archivedAt),
    chat: task.chat ?? null,
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

/** Hands the tasks of a removed manager to the Director's chat. Returns the ones still in use. */
export async function releaseTasksOf(folder: string, chat: string) {
  const released = await updateTasksAt(folder, (tasks) => {
    const own = tasks.filter((task) => task.chat === chat)
    for (const task of own) task.chat = null
    return own
  })
  for (const task of released) notify(folder, task)
  return released.filter(({ archivedAt }) => !archivedAt).map(({ id }) => id)
}

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
  /** Start a subagent: no worktree, no file tools (see the note at the top). */
  subagent?: boolean
  /** Busyboy's MCP endpoint for this task's agent (memory tools), given the project's stored name. */
  taskMcp?: (project: string) => Promise<Record<string, McpServer>>
  /** The manager creating the task; its chat shows the task and its cards. */
  chat?: string
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
  const kind = input.subagent ? ('subagent' as const) : undefined
  const branch = kind ? '' : `busyboy/${id}`
  const worktree = kind ? project.path : join(folder, WORKTREES_FOLDER, project.name, id)
  if (!kind) {
    await mkdir(dirname(worktree), { recursive: true })
    await git(project.path, 'worktree', 'add', '-b', branch, '--', worktree, head)
  }

  let agentId: string | undefined
  try {
    const alwaysAsk = await alwaysAskRulesAt(folder)
    const agent = startAgent({
      provider,
      cwd: worktree,
      instructions: await taskPrompt(folder, { id, project: project.name, worktree, branch, kind }, alwaysAsk),
      mcpServers: input.taskMcp ? await input.taskMcp(project.name) : undefined,
      alwaysAsk,
      noFileEdits: Boolean(kind),
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
      ...(kind ? { kind } : {}),
      ...(input.chat ? { chat: input.chat } : {}),
    }
    await updateTasksAt(folder, (tasks) => void tasks.push(task))
    watchAgent(folder, task)
    sendMessage(agent.id, request)
    notify(folder, task)
    return taskView(task)
  } catch (error) {
    // Leave nothing behind for a task whose agent failed at once.
    if (agentId) await stopAgent(agentId).catch(() => {})
    // A subagent made no worktree: its folder is the project itself.
    if (!kind) {
      await git(project.path, 'worktree', 'remove', '--force', '--', worktree).catch(() => {})
      await git(project.path, 'branch', '-D', '--', branch).catch(() => {})
    }
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
function watchAgent(folder: string, task: TaskRecord, { resumed = false, fromRestart = false, fromMessage = false } = {}) {
  let last = taskView(task).status
  let confirmed = !resumed
  // Until its first turn ends well, an agent started again on a stored session may still find
  // its provider unusable: Claude reports signed-out only inside its first reply, after the session.
  let checkingStart = fromRestart || fromMessage
  const cannot = fromMessage ? continueNote : resumeNote
  let startFailed = false
  /** A subagent that answered: its process is ended on purpose and it stays done. */
  let finished = false
  /** The error a subagent's current turn reported, so a failed turn is not shown as done. */
  let turnError: string | null = null
  const report = () => {
    const status = taskView(task).status
    if (status !== last) {
      last = status
      // Agents the server stops on its way down, and restarted agents whose provider
      // could not start (not installed, signed out), keep their activity and resume
      // on the next start.
      const keep = startFailed || finished || (status === 'stopped' && isStoppingAllAgents())
      if (!keep) void saveTask(folder, task, { activity: status })
      notify(folder, task)
    }
  }
  trackTaskCards({ folder, task, onChange: report })
  trackWorkCards({ folder, task })
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
      // The session is forgotten, so the next message starts a new conversation with the
      // request instead of asking the provider for the same lost one again.
      void saveTask(folder, task, {
        activity: 'stopped',
        sessionId: null,
        note: cannot('the provider no longer has its conversation'),
      }).then(() => notify(folder, task))
      // A lost session never recovers; stop now instead of waiting for the process.
      void stopAgent(task.agentId).catch(() => {})
      last = 'stopped'
      return
    }
    if (event.type === 'error' && checkingStart && !startFailed && isStartFailure(event)) {
      startFailed = true
      // A restart tries again on the next start. A message the user sent is not kept for later:
      // the task stops with the reason, and the user sends it again once the provider works.
      void saveTask(
        folder,
        task,
        fromMessage
          ? { activity: 'stopped', note: cannot(event.message) }
          : { note: cannot(`${event.message} It is tried again the next time BusyBoy starts`) },
      )
      // The provider cannot work until the user fixes it; end the process instead of leaving it idle.
      void stopAgent(task.agentId).catch(() => {})
    }
    if (event.type === 'turn-done') checkingStart = false
    // A subagent does one action: once it has answered, its reply is saved as its result and its
    // process ends, so finished subagents do not each keep a provider process (and its hook gate).
    if (event.type === 'error') turnError = event.message
    if (event.type === 'turn-done' && task.kind === 'subagent' && !finished && getAgent(task.agentId)?.status === 'idle') {
      finished = true
      const reply = lastAgentReply(task.agentId)
      const failed = turnError
      void (async () => {
        // The user may have pressed Stop as the turn ended; that stop stands.
        const stored = (await readTasksAt(folder)).find(({ id }) => id === task.id)
        if (stored?.activity === 'stopped') return
        await saveTask(folder, task, failed ? { activity: 'stopped', note: failed, reply } : { activity: 'idle', reply })
        await stopAgent(task.agentId)
        if (failed) notify(folder, task)
      })().catch(() => {})
    }
    if (event.type === 'turn-done') turnError = null
    // The runner updates its status before it delivers the event.
    report()
  })
}

/** The provider cannot run at all yet; the user can fix it (install, sign in) before the next start. */
const isStartFailure = (event: Extract<AgentEvent, { type: 'error' }>) => event.code === 'not-installed' || event.code === 'signed-out'

const resumeNote = (reason: string) => `Could not resume after BusyBoy restarted: ${reason.replace(/\.$/, '')}.`

/** Why a task whose agent had ended could not take the user's next message. */
const continueNote = (reason: string) => `Could not continue: ${reason.replace(/\.$/, '')}.`

/** Stops a task's agent. The task, its worktree, and its branch stay. */
export async function stopTask(taskId: string) {
  const folder = await dataFolder()
  // After a message that is starting the task's agent again, so the stop reaches the new agent.
  return inTaskOrder(folder, taskId, () => stopTaskNow(folder, taskId))
}

async function stopTaskNow(folder: string, taskId: string) {
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
        // In the task's own order: a message sent while this pass runs must not start a second agent.
        await inTaskOrder(folder, listed.id, async () => {
          // Read again: the user may have stopped this task while earlier ones were resuming.
          const task = (await readTasksAt(folder).catch(() => [] as TaskRecord[])).find(({ id }) => id === listed.id)
          // A live agent belongs to this process already (a dev reload of this module).
          // An archived task stays put away until it is restored.
          if (!task || task.archivedAt || getAgent(task.agentId) || (task.activity !== 'running' && task.activity !== 'needs-you')) return
          if (task.kind === 'subagent') {
            // Its action may have run already (a merge, a push); running it again could do it twice.
            await saveTask(folder, task, { activity: 'stopped', note: 'BusyBoy restarted before this subagent finished. Ask again if it is still needed.' })
            notify(folder, task)
            return
          }
          await resumeTask(folder, task).catch((error: unknown) => {
            // Shown now, but the activity is kept: a read error may pass, so the next start tries again.
            task.note = resumeNote(error instanceof Error ? error.message : String(error))
            void saveTask(folder, task, { note: task.note })
            notify(folder, task)
          })
        }).catch((error: unknown) => console.error(`busyboy: could not resume task ${listed.id}`, error))
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
  // Started in the same tick as the checks below: an agent whose session is gone reports it
  // right after starting, and the watcher must be the one to see that.
  const agent = startAgent(await startAgainInput(folder, task))
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

/** What starts a new agent for a stored task: its provider session, in its worktree. */
async function startAgainInput(folder: string, task: TaskRecord): Promise<StartAgentInput> {
  // Read through a dynamic import: mcp-tools creates tasks, so a static import would be circular.
  const { busyboyMcpServers } = await import('./mcp-tools')
  // Read the list again: the user may have edited it since the task's last agent started.
  const alwaysAsk = await alwaysAskRulesAt(folder)
  return {
    provider: task.provider,
    cwd: task.worktree,
    instructions: await taskPrompt(folder, task, alwaysAsk),
    mcpServers: await busyboyMcpServers(task.project, folder),
    resumeSessionId: task.sessionId ?? undefined,
    alwaysAsk,
  }
}

// ---- Messages after the first request -----------------------------------------

const ORDER_KEY = Symbol.for('busyboy.task-order')
const orderStore = globalThis as typeof globalThis & { [ORDER_KEY]?: Map<string, Promise<unknown>> }
const taskQueues = (orderStore[ORDER_KEY] ??= new Map())

/** Runs `work` after everything queued earlier for the same task: messages, archive, restore. */
function inTaskOrder<T>(folder: string, taskId: string, work: () => Promise<T>): Promise<T> {
  const key = `${folder}\n${taskId}`
  const next = (taskQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  taskQueues.set(key, next)
  void next.catch(() => {}).finally(() => {
    if (taskQueues.get(key) === next) taskQueues.delete(key)
  })
  return next
}

/**
 * Sends the task's agent another message: a review comment to address, a change on the same
 * branch. An agent that is still alive gets it at once (after its current turn, when one runs).
 * An agent that has ended (the task was stopped, or BusyBoy restarted while it was idle) is
 * started again on its stored session in the same worktree first, so the work carries on where
 * it was instead of in a new task from the project's HEAD.
 */
export function messageTaskAt(folder: string, taskId: string, text: string): Promise<TaskView> {
  // One at a time per task: two messages to an ended agent must not start two agents.
  return inTaskOrder(folder, taskId, () => deliverMessage(folder, taskId, text))
}

/** Resolves once the agent's process has ended, or after a few seconds if it does not end. */
function agentEnded(agentId: string, timeoutMs = 5000): Promise<void> {
  if ((getAgent(agentId)?.status ?? 'stopped') === 'stopped') return Promise.resolve()
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const done = () => {
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    unsubscribe = subscribeToAgent(agentId, getAgent(agentId)?.lastSeq ?? 0, ({ event }) => {
      if (event.type === 'stopped') done()
    })
    if ((getAgent(agentId)?.status ?? 'stopped') === 'stopped') done()
  })
}

async function deliverMessage(folder: string, taskId: string, text: string): Promise<TaskView> {
  const message = text.trim()
  if (!message) throw new TaskError('Give the message to send.')
  const task = (await readTasksAt(folder)).find(({ id }) => id === taskId)
  if (!task) throw new TaskError(`There is no task ${taskId}.`)
  const name = `${task.project} · ${task.title}`
  // More work for an archived task means it is wanted again.
  if (task.archivedAt && task.kind !== 'subagent') await restore(folder, task)
  if (task.kind === 'subagent') throw new TaskError(`${name} is a subagent: it does one action and takes no further messages. Start a new one.`)
  // An open card is the agent's own question; a message beside it would leave the card unanswered.
  if (hasOpenCard(task.agentId)) throw new TaskError(`${name} is waiting on a card. Answer or reply to that card instead.`)
  // Stop saves `stopped` before the agent's process has ended. A message written to that
  // closing agent would be lost, so wait for it to end and start a new one.
  if (task.activity === 'stopped') await agentEnded(task.agentId)
  const live = getAgent(task.agentId)
  if (live && live.status !== 'stopped') {
    sendMessage(task.agentId, message)
    return taskView(task)
  }

  try {
    await readFile(join(task.worktree, '.git'))
  } catch {
    throw new TaskError(`${name} cannot continue: its worktree ${task.worktree} is gone.`)
  }
  // Read before the agent starts: its session event updates `task` while this awaits.
  const { sessionId, agentId: ended } = task
  const agent = startAgent(await startAgainInput(folder, task))
  if (getAgent(agent.id)?.status === 'stopped') {
    const reason = startError(agent.id)
    removeAgent(agent.id)
    throw new TaskError(`${name} could not start again: ${reason}`)
  }
  task.agentId = agent.id
  const saved = saveTask(folder, task, { agentId: agent.id, note: null })
  watchAgent(folder, task, { resumed: Boolean(sessionId), fromMessage: true })
  await saved
  // Nothing reads the ended agent's events any more.
  removeAgent(ended)
  try {
    // Without a stored session the provider never kept the request, so the new conversation gets it first.
    sendMessage(agent.id, sessionId ? message : `${task.request}\n\n${message}`)
  } catch {
    // It stopped in between (a lost session, a missing CLI); the watcher has noted why.
    throw new TaskError(`${name} could not start again: ${startError(agent.id)}`)
  }
  notify(folder, task)
  return taskView(task)
}

export async function messageTask(taskId: string, text: string) {
  return messageTaskAt(await dataFolder(), taskId, text)
}

// ---- Archive ------------------------------------------------------------------

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

/**
 * Archives a task that is not working. Returns the task and whether its worktree was kept:
 * git refuses to remove a worktree with changed or untracked files, and that refusal is what
 * keeps uncommitted work from being lost.
 */
export async function archiveTask(taskId: string): Promise<{ task: TaskView; worktreeKept: boolean }> {
  const folder = await dataFolder()
  return inTaskOrder(folder, taskId, async () => {
    const task = (await readTasksAt(folder)).find(({ id }) => id === taskId)
    if (!task) throw new TaskError(`There is no task ${taskId}.`)
    if (task.archivedAt) return { task: taskView(task), worktreeKept: task.kind !== 'subagent' && (await exists(task.worktree)) }
    const { status } = taskView(task)
    if (status === 'running' || status === 'needs-you') {
      throw new TaskError(`${task.project} · ${task.title} is still working. Stop it before archiving it.`)
    }
    // An idle agent still has a provider process. Its `stopped` event comes after the stop
    // call returns; once it has, nothing reads the agent's events any more.
    await stopTaskAgent({ folder, agentId: task.agentId })
    await agentEnded(task.agentId)
    removeAgent(task.agentId)
    const worktreeKept = task.kind !== 'subagent' && !(await removeWorktree(folder, task))
    // A task whose provider could not start after a restart keeps `running` so the next start
    // tries again; archived, it must not be started then.
    const activity = task.activity === 'running' || task.activity === 'needs-you' ? 'stopped' : task.activity
    await saveTask(folder, task, { archivedAt: new Date().toISOString(), activity })
    notify(folder, task)
    return { task: taskView(task), worktreeKept }
  })
}

/**
 * Removes the task's worktree unless that would lose work. Returns whether it is gone.
 * The branch stays, so everything committed stays.
 */
async function removeWorktree(folder: string, task: TaskRecord) {
  // Not a worktree any more (removed by hand): gone if the folder is, kept if something is left in it.
  if (!(await exists(join(task.worktree, '.git')))) return !(await exists(task.worktree))
  const records = join(task.worktree, RECORDS_FOLDER)
  const shelf = join(folder, ARCHIVE_FOLDER, task.project, task.id, RECORDS_FOLDER)
  let shelved = false
  try {
    // The agent's records are untracked files, which would make git refuse every archive, and
    // forcing the removal would delete the plan. They wait in the data folder instead. Records
    // a project commits are on the branch already and stay where they are.
    const tracked = (await git(task.worktree, 'ls-files', '--', RECORDS_FOLDER)) !== ''
    const isFolder = await lstat(records).then(
      (stats) => stats.isDirectory(),
      () => false,
    )
    // Records already waiting there are from an archive that could not put them back; they are
    // never overwritten. The records then stay in the worktree, and git keeps it.
    if (!tracked && isFolder && !(await exists(shelf))) {
      await mkdir(dirname(shelf), { recursive: true })
      await rename(records, shelf)
      shelved = true
    }
    // Asked of the repository, not the worktree: git cannot remove the folder it runs in.
    const repository = await git(task.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    await run('git', [`--git-dir=${repository}`, 'worktree', 'remove', '--', task.worktree], { env: agentEnvironment() as NodeJS.ProcessEnv })
    return true
  } catch {
    // Changed or untracked files (or a worktree git cannot read): keep it as it is.
    if (shelved) {
      // Only when the records are back: a failed move leaves them on the shelf, where restore finds them.
      const back = await rename(shelf, records).then(
        () => true,
        () => false,
      )
      if (back) await rm(dirname(shelf), { recursive: true, force: true })
    }
    return false
  }
}

/** Brings an archived task back: its worktree on its branch, and its records. */
export async function restoreTask(taskId: string): Promise<TaskView> {
  const folder = await dataFolder()
  return inTaskOrder(folder, taskId, async () => {
    const task = (await readTasksAt(folder)).find(({ id }) => id === taskId)
    if (!task) throw new TaskError(`There is no task ${taskId}.`)
    if (task.archivedAt) await restore(folder, task)
    return taskView(task)
  })
}

async function restore(folder: string, task: TaskRecord) {
  const name = `${task.project} · ${task.title}`
  if (task.kind !== 'subagent' && !(await exists(join(task.worktree, '.git')))) {
    const project = await getProject(task.project)
    if (!project) throw new TaskError(`${name} cannot be restored: the project ${task.project} is no longer in BusyBoy.`)
    try {
      // Forget the removed worktree first, in case it was deleted by hand rather than by git.
      await git(project.path, 'worktree', 'prune')
      await mkdir(dirname(task.worktree), { recursive: true })
      await git(project.path, 'worktree', 'add', '--', task.worktree, task.branch)
    } catch (error) {
      throw new TaskError(`${name} cannot be restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (task.kind !== 'subagent') {
    // Also for a worktree that was kept: an archive that could not put the records back left them waiting.
    const records = join(task.worktree, RECORDS_FOLDER)
    const shelf = join(folder, ARCHIVE_FOLDER, task.project, task.id)
    if ((await exists(join(shelf, RECORDS_FOLDER))) && !(await exists(records))) {
      await rename(join(shelf, RECORDS_FOLDER), records)
      await rm(shelf, { recursive: true, force: true })
    }
  }
  task.archivedAt = null
  await saveTask(folder, task, { archivedAt: null })
  notify(folder, task)
}
