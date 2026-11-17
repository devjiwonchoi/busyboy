import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { alwaysAskRulesAt } from './always-ask-list'
import { rulesFolderFor } from './runner/user-rules'
import { gitPath, pathKey } from './paths'
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
import { finishRememberRecord, observeTaskMessage, observeTaskTurn } from './records/remember-record'
import { taskRecordDirectory } from './records/record-location'
import { rememberRoot } from './records/remember-root'
import type { AttachmentInput } from '@/lib/chat-attachments'
import { attachmentsTurn } from './chat-attachments'
import { displayText } from './runner/user-turn'
import { APPROVE_MESSAGE, hasOpenCard, stopTaskAgent, trackTaskCards } from './task-cards'
import type { AgentEvent, AgentStatus, McpServer, ProviderId, StartAgentInput } from './runner/contract'

// Both folder names are new, so the legacy app's worktrees/ and other files in the data folder are never touched.
// Files git ignores go with the worktree: keeping every worktree that has a node_modules would keep nearly all of them.

export const TASKS_FILE = 'task-list.json'
export const WORKTREES_FOLDER = 'task-worktrees'
export const ARCHIVE_FOLDER = 'task-archive'
const RECORDS_FOLDER = '.jwn'

export type TaskRecord = {
  id: string
  project: string
  title: string
  request: string
  provider: ProviderId
  agentId: string
  sessionId: string | null
  worktree: string
  branch: string
  createdAt: string
  kind?: 'subagent'
  reply?: string | null
  // A stop made by the server itself is not saved, so quitting does not look like the task stopped.
  activity?: TaskStatus
  note?: string | null
  archivedAt?: string | null
  chat?: string | null
}

export type TaskStatus = 'running' | 'needs-you' | 'idle' | 'stopped'

export type TaskView = Pick<TaskRecord, 'id' | 'project' | 'title' | 'branch' | 'createdAt'> & {
  status: TaskStatus
  note: string | null
  subagent: boolean
  reply: string | null
  archived: boolean
  chat: string | null
}

export class TaskError extends Error {}

const run = promisify(execFile)

export function taskInstructions(task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'branch'>, alwaysAsk: string[], recordFolder: string) {
  return [
    `You are a busyboy task agent for the project "${task.project}".`,
    `You work in the git worktree ${task.worktree} on the branch ${task.branch}. Stay inside this worktree.`,
    'Plan the task with the `align` skill before you change anything, and follow the plan once it is approved.',
    `Keep every record of this task (the plan and any status, verify, or review notes your skills write) in ${recordFolder}/. That is this task's folder in the jwn record root. Do not write those files into the worktree.`,
    '',
    'Approval:',
    // The align skill saves the plan only after approval, but the card needs the draft on disk before the agent waits.
    `- When the plan is ready for approval, save it as ${recordFolder}/ALIGN.md with "Status: draft", present it, and end your turn. BusyBoy shows it to the user as a plan card.`,
    `- The message "${APPROVE_MESSAGE}" approves the plan as saved: change its Status line to approved and carry on. Any other reply asks for changes; revise the draft and end your turn again.`,
    '- Do reversible actions without asking, then say what you did. Ask before irreversible ones.',
    `- Record progress in ${recordFolder}/STATUS.md as you go: a State line (running, or done when the task is finished) and a "| Todo | Result |" table whose rows match the plan's todos. BusyBoy shows a progress card from that table, and a one-line done card once State is done.`,
    '- When you open pull requests, add a "# Pull requests" table to that STATUS.md with columns Number, Title, URL, Check, and Review. One row per pull request, in stack order, the base of the stack first. BusyBoy lists them on a card and does not merge them.',
    ...(alwaysAsk.length > 0
      ? [
          '- BusyBoy asks the user before every tool call that matches one of these rules, even when the plan approved it, so expect to wait for an answer there:',
          ...alwaysAsk.map((rule) => `  - ${rule}`),
        ]
      : []),
    '- Rules in ~/.jwn block a matching tool call until the user allows it. If a rule cannot be checked, the action is blocked until the user answers.',
    '',
    'Memory:',
    '- The Memory section below is what BusyBoy remembers about the user and this project. Follow it.',
    `- Save what later tasks in ${task.project} need (a user preference, a convention of this project) with the busyboy memory_write tool as soon as you learn it. Your writes always go to this project's memory.`,
    '- When the task ends, add one memory_write line with kind "log" saying what was done and where.',
    REVERT_AND_REMEMBER,
  ].join('\n')
}

export function subagentInstructions(task: Pick<TaskRecord, 'project' | 'worktree'>, alwaysAsk: string[]) {
  return [
    `You are a busyboy subagent for the project "${task.project}", started for one short action such as merging a pull request, checking CI, or running a command.`,
    `You run in the project's own checkout, ${task.worktree}, which the user works in. Do not edit files, switch branches, or change the checkout: BusyBoy asks the user before any tool call that could. If the request needs file changes, stop and say it needs a task.`,
    'Do the action without planning, then reply in one or two sentences with the result. The user sees that reply.',
    ...(alwaysAsk.length > 0
      ? ['BusyBoy asks the user before every tool call that matches one of these rules, so expect to wait for an answer there:', ...alwaysAsk.map((rule) => `- ${rule}`)]
      : []),
    'Rules in ~/.jwn block a matching tool call until the user allows it. If a rule cannot be checked, the action is blocked until the user answers.',
  ].join('\n')
}

async function taskPrompt(folder: string, task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'branch' | 'kind'>, alwaysAsk: string[], recordFolder: string | null) {
  const instructions = task.kind === 'subagent' ? subagentInstructions(task, alwaysAsk) : taskInstructions(task, alwaysAsk, recordFolder ?? 'the jwn record root')
  return `${instructions}\n\n${await memoryPrompt(folder, { project: task.project })}`
}

async function recordsFor(folder: string, task: Pick<TaskRecord, 'id' | 'project' | 'worktree' | 'kind'>) {
  if (task.kind === 'subagent') return null
  const directory = await taskRecordDirectory(folder, task)
  return typeof directory === 'string' ? directory : null
}


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

function updateTasksAt<T>(folder: string, change: (tasks: TaskRecord[]) => T): Promise<T> {
  const file = join(folder, TASKS_FILE)
  const key = pathKey(file)
  const next = (writeQueues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const tasks = await readTasksAt(folder)
      const result = change(tasks)
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`)
      await rename(temporary, file)
      return result
    })
  writeQueues.set(key, next)
  return next
}


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
  const ended = !agent || (task.kind === 'subagent' && agent.status === 'stopped')
  const status = ended && task.activity === 'idle' ? 'idle' : statusOf(agent?.status)
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

export function subscribeToTasks(folder: string, listener: (task: TaskView) => void) {
  void resumeTasks(folder)
  const key = pathKey(folder)
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

function notify(folder: string, task: TaskRecord) {
  const view = taskView(task)
  for (const listener of listeners.get(pathKey(folder)) ?? []) listener(view)
}


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

async function git(cwd: string, ...args: string[]) {
  try {
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
  subagent?: boolean
  taskMcp?: (project: string) => Promise<Record<string, McpServer>>
  chat?: string
}

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
  // The name becomes a folder, so a name with a path in it would put the worktree outside the data folder.
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
    const taskRef = { id, project: project.name, worktree, branch, kind }
    const recordFolder = await recordsFor(folder, taskRef)
    const agent = startAgent({
      provider,
      cwd: worktree,
      instructions: await taskPrompt(folder, taskRef, alwaysAsk, recordFolder),
      recordFolder: recordFolder ?? undefined,
      mcpServers: input.taskMcp ? await input.taskMcp(project.name) : undefined,
      alwaysAsk,
      noFileEdits: Boolean(kind),
      rulesFolder: rulesFolderFor(folder),
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
    if (agentId) await stopAgent(agentId).catch(() => {})
    if (!kind) {
      await git(project.path, 'worktree', 'remove', '--force', '--', worktree).catch(() => {})
      await git(project.path, 'branch', '-D', '--', branch).catch(() => {})
    }
    await updateTasksAt(folder, (tasks) => void tasks.splice(0, tasks.length, ...tasks.filter((task) => task.id !== id))).catch(
      () => {},
    )
    if (error instanceof TaskError) throw error
    if (agentId && getAgent(agentId)?.status === 'stopped') throw new TaskError(`The task agent could not start: ${startError(agentId)}`)
    throw new TaskError(`The task could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function startFailedAlready(agentId: string) {
  let failed = false
  subscribeToAgent(agentId, 0, ({ event }) => {
    if (event.type === 'error' && isStartFailure(event)) failed = true
  })?.()
  return failed
}

function startError(agentId: string) {
  let message = 'unknown error'
  subscribeToAgent(agentId, 0, ({ event }) => {
    if (event.type === 'error') message = event.message
  })?.()
  return message
}

function saveTask(folder: string, task: TaskRecord, change: Partial<TaskRecord>) {
  Object.assign(task, change)
  return updateTasksAt(folder, (tasks) => {
    const stored = tasks.find(({ id }) => id === task.id)
    if (stored) Object.assign(stored, change)
  }).catch((error: unknown) => console.error(`busyboy: could not save task ${task.id}`, error))
}

function watchAgent(folder: string, task: TaskRecord, { resumed = false, fromRestart = false, fromMessage = false } = {}) {
  let last = taskView(task).status
  let confirmed = !resumed
  // Claude reports signed-out only inside its first reply, after the session.
  let checkingStart = fromRestart || fromMessage
  const cannot = fromMessage ? continueNote : resumeNote
  let startFailed = false
  let finished = false
  let turnError: string | null = null
  const report = () => {
    const status = taskView(task).status
    if (status !== last) {
      last = status
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
    // Claude confirms a resumed session only with its first reply, so an idle resumed agent can stay unconfirmed.
    if (event.type === 'error' && !confirmed && isLostSessionError(event)) {
      confirmed = true
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
      void saveTask(
        folder,
        task,
        fromMessage
          ? { activity: 'stopped', note: cannot(event.message) }
          : { note: cannot(`${event.message} It is tried again the next time BusyBoy starts`) },
      )
      void stopAgent(task.agentId).catch(() => {})
    }
    if (event.type === 'turn-done') checkingStart = false
    if (event.type === 'error') turnError = event.message
    if (event.type === 'turn-done' && task.kind === 'subagent' && !finished && getAgent(task.agentId)?.status === 'idle') {
      finished = true
      const reply = lastAgentReply(task.agentId)
      const failed = turnError
      void (async () => {
        const stored = (await readTasksAt(folder)).find(({ id }) => id === task.id)
        if (stored?.activity === 'stopped') return
        await saveTask(folder, task, failed ? { activity: 'stopped', note: failed, reply } : { activity: 'idle', reply })
        await stopAgent(task.agentId)
        if (failed) notify(folder, task)
      })().catch(() => {})
    }
    if (event.type === 'turn-done') turnError = null
    if (task.kind !== 'subagent') {
      if (event.type === 'user-message') {
        observeTaskMessage({
          folder,
          task,
          approval: event.text.trim() === APPROVE_MESSAGE,
          system: event.text === RESUME_WORKING_MESSAGE || event.text === RESUME_WAITING_MESSAGE,
        })
      } else if (event.type === 'turn-done') {
        void observeTaskTurn({ folder, task, root: rememberRoot(folder), interrupted: Boolean(event.interrupted) }).catch((error: unknown) =>
          console.error(`busyboy: could not update the remember record for ${task.id}`, error),
        )
      }
    }
    report()
  })
}

const isStartFailure = (event: Extract<AgentEvent, { type: 'error' }>) => event.code === 'not-installed' || event.code === 'signed-out'

const resumeNote = (reason: string) => `Could not resume after BusyBoy restarted: ${reason.replace(/\.$/, '')}.`

const continueNote = (reason: string) => `Could not continue: ${reason.replace(/\.$/, '')}.`

export async function stopTask(taskId: string) {
  const folder = await dataFolder()
  return inTaskOrder(folder, taskId, () => stopTaskNow(folder, taskId))
}

async function stopTaskNow(folder: string, taskId: string) {
  const task = (await readTasksAt(folder)).find(({ id }) => id === taskId)
  if (!task) {
    throw new TaskError(`There is no task ${taskId}.`)
  }
  await updateTasksAt(folder, (tasks) => {
    const stored = tasks.find(({ id }) => id === taskId)
    if (stored) stored.activity = 'stopped'
  })
  task.activity = 'stopped'
  if (!getAgent(task.agentId)) notify(folder, task)
  await stopTaskAgent({ folder, agentId: task.agentId })
}


// The last step may or may not have finished, and only the agent can tell, so the request is not sent again.
export const RESUME_WORKING_MESSAGE =
  'BusyBoy restarted while you were working, so your last step may not have finished. Check what is already done in the worktree before you continue, so nothing runs twice, then carry on with the task.'

export const RESUME_WAITING_MESSAGE =
  'BusyBoy restarted while you were waiting for the user, and your request to them was lost. Ask them again the same way, and do nothing else until they answer.'

const RESUMES_KEY = Symbol.for('busyboy.task-resumes')
const resumeStore = globalThis as typeof globalThis & { [RESUMES_KEY]?: Map<string, Promise<void>> }
const resumes = (resumeStore[RESUMES_KEY] ??= new Map())

// Idle tasks are left alone: starting a provider process for each of them would load a small machine for nothing.
export function resumeTasks(folder: string): Promise<void> {
  const key = pathKey(folder)
  let resume = resumes.get(key)
  if (!resume) {
    resume = (async () => {
      const tasks = await readTasksAt(folder).catch(() => [] as TaskRecord[])
      for (const listed of tasks) {
        if (isStoppingAllAgents()) return
        await inTaskOrder(folder, listed.id, async () => {
          const task = (await readTasksAt(folder).catch(() => [] as TaskRecord[])).find(({ id }) => id === listed.id)
          if (!task || task.archivedAt || getAgent(task.agentId) || (task.activity !== 'running' && task.activity !== 'needs-you')) return
          if (task.kind === 'subagent') {
            // Its action may have run already. Running it again could do it twice.
            await saveTask(folder, task, { activity: 'stopped', note: 'BusyBoy restarted before this subagent finished. Ask again if it is still needed.' })
            notify(folder, task)
            return
          }
          await resumeTask(folder, task).catch((error: unknown) => {
            task.note = resumeNote(error instanceof Error ? error.message : String(error))
            void saveTask(folder, task, { note: task.note })
            notify(folder, task)
          })
        }).catch((error: unknown) => console.error(`busyboy: could not resume task ${listed.id}`, error))
      }
    })()
    resumes.set(key, resume)
  }
  return resume
}

async function resumeTask(folder: string, task: TaskRecord) {
  const { activity, sessionId } = task
  try {
    await readFile(join(task.worktree, '.git'))
  } catch {
    await saveTask(folder, task, { activity: 'stopped', note: resumeNote(`its worktree ${task.worktree} is gone`) })
    notify(folder, task)
    return
  }
  const agent = startAgent(await startAgainInput(folder, task))
  task.agentId = agent.id
  if (getAgent(agent.id)?.status === 'stopped') {
    await saveTask(folder, task, { agentId: agent.id, note: resumeNote(startError(agent.id)) })
    notify(folder, task)
    return
  }
  const saved = saveTask(folder, task, { agentId: agent.id, note: null })
  watchAgent(folder, task, { resumed: Boolean(sessionId), fromRestart: true })
  await saved
  notify(folder, task)
  // A lost session or a missing CLI may already have ended the agent; the watcher has noted why.
  if (getAgent(agent.id)?.status === 'stopped' || startFailedAlready(agent.id)) return
  try {
    // Claude reports its session with its first reply, so a crash in between can still send the request twice. That window is one file write.
    if (!sessionId) sendMessage(agent.id, task.request)
    else if (activity === 'running') sendMessage(agent.id, RESUME_WORKING_MESSAGE)
    else if (activity === 'needs-you') sendMessage(agent.id, RESUME_WAITING_MESSAGE)
  } catch (error) {
    console.error(`busyboy: could not message resumed task ${task.id}`, error)
  }
}

async function startAgainInput(folder: string, task: TaskRecord): Promise<StartAgentInput> {
  const { busyboyMcpServers } = await import('./mcp-tools')
  const alwaysAsk = await alwaysAskRulesAt(folder)
  const recordFolder = await recordsFor(folder, task)
  return {
    provider: task.provider,
    cwd: task.worktree,
    instructions: await taskPrompt(folder, task, alwaysAsk, recordFolder),
    recordFolder: recordFolder ?? undefined,
    mcpServers: await busyboyMcpServers(task.project, folder),
    resumeSessionId: task.sessionId ?? undefined,
    alwaysAsk,
    rulesFolder: rulesFolderFor(folder),
  }
}


const ORDER_KEY = Symbol.for('busyboy.task-order')
const orderStore = globalThis as typeof globalThis & { [ORDER_KEY]?: Map<string, Promise<unknown>> }
const taskQueues = (orderStore[ORDER_KEY] ??= new Map())

function inTaskOrder<T>(folder: string, taskId: string, work: () => Promise<T>): Promise<T> {
  const key = `${pathKey(folder)}\n${taskId}`
  const next = (taskQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  taskQueues.set(key, next)
  void next.catch(() => {}).finally(() => {
    if (taskQueues.get(key) === next) taskQueues.delete(key)
  })
  return next
}

export function messageTaskAt(folder: string, taskId: string, message: TaskMessage): Promise<{ view: TaskView; shown: string }> {
  return inTaskOrder(folder, taskId, () => deliverMessage(folder, taskId, message))
}

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

type TaskMessage = string | { text: string; attachments?: AttachmentInput[] }

async function deliverMessage(folder: string, taskId: string, input: TaskMessage): Promise<{ view: TaskView; shown: string }> {
  const text = typeof input === 'string' ? input : input.text
  const attachments = typeof input === 'string' ? [] : (input.attachments ?? [])
  const task = (await readTasksAt(folder)).find(({ id }) => id === taskId)
  if (!task) throw new TaskError(`There is no task ${taskId}.`)
  const turn = await attachmentsTurn({ folder: task.worktree, text, attachments })
  const message = displayText(turn)
  if (!message) throw new TaskError('Give the message to send.')
  const name = `${task.project} · ${task.title}`
  if (task.archivedAt && task.kind !== 'subagent') await restore(folder, task)
  if (task.kind === 'subagent') throw new TaskError(`${name} is a subagent: it does one action and takes no further messages. Start a new one.`)
  if (hasOpenCard(task.agentId)) throw new TaskError(`${name} is waiting on a card. Answer or reply to that card instead.`)
  if (task.activity === 'stopped') await agentEnded(task.agentId)
  const live = getAgent(task.agentId)
  if (live && live.status !== 'stopped') {
    sendMessage(task.agentId, turn)
    return { view: taskView(task), shown: message }
  }

  try {
    await readFile(join(task.worktree, '.git'))
  } catch {
    throw new TaskError(`${name} cannot continue: its worktree ${task.worktree} is gone.`)
  }
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
  removeAgent(ended)
  try {
    sendMessage(agent.id, sessionId ? turn : { ...turn, text: `${task.request}\n\n${turn.text}` })
  } catch {
    // It stopped in between (a lost session, a missing CLI); the watcher has noted why.
    throw new TaskError(`${name} could not start again: ${startError(agent.id)}`)
  }
  notify(folder, task)
  return { view: taskView(task), shown: message }
}

export async function messageTask(taskId: string, text: string) {
  return (await messageTaskAt(await dataFolder(), taskId, text)).view
}


const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

// git refuses to remove a worktree with changed or untracked files, which keeps uncommitted work.
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
    await stopTaskAgent({ folder, agentId: task.agentId })
    await agentEnded(task.agentId)
    removeAgent(task.agentId)
    if (task.kind !== 'subagent') {
      await finishRememberRecord({ folder, task, root: rememberRoot(folder) }).catch((error: unknown) =>
        console.error(`busyboy: could not write the remember record for ${task.id}`, error),
      )
    }
    const worktreeKept = task.kind !== 'subagent' && !(await removeWorktree(folder, task))
    const activity = task.activity === 'running' || task.activity === 'needs-you' ? 'stopped' : task.activity
    await saveTask(folder, task, { archivedAt: new Date().toISOString(), activity })
    notify(folder, task)
    return { task: taskView(task), worktreeKept }
  })
}

async function removeWorktree(folder: string, task: TaskRecord) {
  if (!(await exists(join(task.worktree, '.git')))) return !(await exists(task.worktree))
  const records = join(task.worktree, RECORDS_FOLDER)
  const shelf = join(folder, ARCHIVE_FOLDER, task.project, task.id, RECORDS_FOLDER)
  let shelved = false
  try {
    // The records are untracked, which would make git refuse every archive, and forcing the removal would delete the plan.
    const tracked = (await git(task.worktree, 'ls-files', '--', RECORDS_FOLDER)) !== ''
    const isFolder = await lstat(records).then(
      (stats) => stats.isDirectory(),
      () => false,
    )
    if (!tracked && isFolder && !(await exists(shelf))) {
      await mkdir(dirname(shelf), { recursive: true })
      await rename(records, shelf)
      shelved = true
    }
    const repository = await git(task.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    // --git-dir= is one argument git parses itself. A backslash there is an escape, so C:\repo misses the worktree.
    await run('git', [`--git-dir=${gitPath(repository)}`, 'worktree', 'remove', '--', gitPath(task.worktree)], { env: agentEnvironment() as NodeJS.ProcessEnv })
    return true
  } catch {
    if (shelved) {
      const back = await rename(shelf, records).then(
        () => true,
        () => false,
      )
      if (back) await rm(dirname(shelf), { recursive: true, force: true })
    }
    return false
  }
}

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
      await git(project.path, 'worktree', 'prune')
      await mkdir(dirname(task.worktree), { recursive: true })
      await git(project.path, 'worktree', 'add', '--', task.worktree, task.branch)
    } catch (error) {
      throw new TaskError(`${name} cannot be restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (task.kind !== 'subagent') {
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
