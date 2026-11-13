import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MASTER_INSTRUCTIONS, masterTiming } from './master-context'
import {
  answerAgent,
  compactAgent,
  getAgent,
  interruptAgent,
  resumeAgent,
  sendMessage,
  startAgent,
  stopAgent,
  subscribeToAgent,
} from './runner/agent-runner'
import type { AgentEventEnvelope, McpServerInput, ProviderId } from './runner/contract'
import { listTasksAt, subscribeToTasks, type TaskView } from './tasks'

// The master: one long-lived agent per data folder that answers the user and
// creates tasks through busyboy's MCP tools. What the user sees is kept in
// its own transcript file, so it never depends on what the provider session
// still holds after compaction or a lost session.
//
//   <data>/master/transcript.jsonl   display transcript, one entry per line
//   <data>/master/state.json         provider and session id for resume
//   <data>/master/                   also the master agent's working directory

export const MASTER_FOLDER = 'master'
const TRANSCRIPT_FILE = 'transcript.jsonl'
const STATE_FILE = 'state.json'

export type ChatEntry =
  | { id: string; at: string; kind: 'user'; text: string }
  | { id: string; at: string; kind: 'master'; text: string; interrupted?: boolean }
  /** Tasks the master created in one turn. */
  | { id: string; at: string; kind: 'tasks'; taskIds: string[] }
  | { id: string; at: string; kind: 'note'; text: string; tone: 'info' | 'error'; compacted?: boolean }

export type MasterStatus = 'idle' | 'answering' | 'compacting'

export type MasterUpdate =
  | { type: 'reset'; entries: ChatEntry[]; tasks: TaskView[]; status: MasterStatus; draft: string }
  /** Appends the entry, or replaces the one with the same id. */
  | { type: 'entry'; entry: ChatEntry }
  /** The master's reply as it streams; empty when no reply is streaming. */
  | { type: 'draft'; text: string }
  | { type: 'status'; status: MasterStatus }
  | { type: 'task'; task: TaskView }

type MasterState = { provider?: ProviderId; sessionId?: string }

type Master = {
  folder: string
  ready: Promise<void>
  entries: ChatEntry[]
  state: MasterState
  agentId?: string
  status: MasterStatus
  draft: string
  /** Messages waiting for the batch window to close. */
  pending: string[]
  batchTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  /** The tasks entry of the turn in progress, so one turn's tasks share one bubble. */
  turnTasksId?: string
  charsSinceCompact: number
  /** An error arrived during the compaction in progress. */
  compactFailed?: boolean
  /** The provider and MCP endpoint from the latest message, used for the next turn. */
  target?: { provider: ProviderId; mcp: McpServerInput }
  writes: Promise<unknown>
  listeners: Set<(update: MasterUpdate) => void>
}

// Kept on globalThis so `next dev` reloads keep the running master.
const MASTERS_KEY = Symbol.for('busyboy.masters')
const globalStore = globalThis as typeof globalThis & { [MASTERS_KEY]?: Map<string, Master> }
const masters = (globalStore[MASTERS_KEY] ??= new Map())

const masterFolder = (master: Master) => join(master.folder, MASTER_FOLDER)

function getMaster(folder: string): Master {
  let master = masters.get(folder)
  if (master) return master
  master = {
    folder,
    ready: Promise.resolve(),
    entries: [],
    state: {},
    status: 'idle',
    draft: '',
    pending: [],
    charsSinceCompact: 0,
    writes: Promise.resolve(),
    listeners: new Set(),
  }
  master.ready = load(master)
  subscribeToTasks(folder, (task) => broadcast(master, { type: 'task', task }))
  masters.set(folder, master)
  return master
}

async function load(master: Master) {
  const folder = masterFolder(master)
  const lines = (await readFile(join(folder, TRANSCRIPT_FILE), 'utf8').catch(() => '')).split('\n')
  const byId = new Map<string, ChatEntry>()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as ChatEntry
      byId.set(entry.id, entry)
    } catch {
      // A line cut short by a crash; skip it.
    }
  }
  master.entries = [...byId.values()]
  const lastCompaction = master.entries.findLastIndex((entry) => entry.kind === 'note' && entry.compacted)
  master.charsSinceCompact = master.entries.slice(lastCompaction + 1).reduce((sum, entry) => sum + entryLength(entry), 0)
  try {
    master.state = JSON.parse(await readFile(join(folder, STATE_FILE), 'utf8')) as MasterState
  } catch {
    // Missing or unreadable: the next message starts a new provider session.
    master.state = {}
  }
}

function entryLength(entry: ChatEntry) {
  return entry.kind === 'user' || entry.kind === 'master' ? entry.text.length : 0
}

function broadcast(master: Master, update: MasterUpdate) {
  for (const listener of master.listeners) listener(update)
}

function setStatus(master: Master, status: MasterStatus) {
  if (master.status === status) return
  master.status = status
  broadcast(master, { type: 'status', status })
}

function setDraft(master: Master, text: string) {
  master.draft = text
  broadcast(master, { type: 'draft', text })
}

/** Appends a new entry, or replaces the one with the same id (the file keeps the last line per id). */
function saveEntry(master: Master, entry: ChatEntry) {
  const index = master.entries.findIndex(({ id }) => id === entry.id)
  if (index === -1) {
    master.entries.push(entry)
    master.charsSinceCompact += entryLength(entry)
  } else master.entries[index] = entry
  broadcast(master, { type: 'entry', entry })
  const folder = masterFolder(master)
  master.writes = master.writes
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      await appendFile(join(folder, TRANSCRIPT_FILE), `${JSON.stringify(entry)}\n`)
    })
}

function newEntry<K extends ChatEntry['kind']>(kind: K, fields: Omit<Extract<ChatEntry, { kind: K }>, 'id' | 'at' | 'kind'>) {
  return { id: randomUUID(), at: new Date().toISOString(), kind, ...fields } as Extract<ChatEntry, { kind: K }>
}

function saveState(master: Master) {
  const folder = masterFolder(master)
  const state = { ...master.state }
  master.writes = master.writes
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      const file = join(folder, STATE_FILE)
      await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
      await rename(`${file}.tmp`, file)
    })
}

// ---- The master agent ----------------------------------------------------------

async function ensureAgent(master: Master, provider: ProviderId, mcp: McpServerInput) {
  const existing = master.agentId ? getAgent(master.agentId) : undefined
  if (existing && existing.provider === provider) {
    if (existing.status === 'stopped') resumeAgent(existing.id)
    return existing.id
  }
  if (existing) {
    // The default provider changed: its conversation cannot carry over.
    master.agentId = undefined
    void stopAgent(existing.id)
    saveEntry(master, newEntry('note', { text: `Started a new conversation on ${provider}.`, tone: 'info' }))
  }
  const cwd = masterFolder(master)
  await mkdir(cwd, { recursive: true })
  const agent = startAgent({
    provider,
    cwd,
    instructions: MASTER_INSTRUCTIONS,
    mcpServers: [mcp],
    resumeSessionId: master.state.provider === provider ? master.state.sessionId : undefined,
  })
  master.agentId = agent.id
  subscribeToAgent(agent.id, 0, (envelope) => onAgentEvent(master, agent.id, envelope))
  return agent.id
}

function onAgentEvent(master: Master, agentId: string, { event }: AgentEventEnvelope) {
  if (master.agentId !== agentId) return
  const compacting = master.status === 'compacting'
  switch (event.type) {
    case 'session':
      if (master.state.sessionId !== event.sessionId) {
        master.state = { provider: getAgent(agentId)?.provider, sessionId: event.sessionId }
        saveState(master)
      }
      break
    case 'text-delta':
      if (!compacting) setDraft(master, master.draft + event.text)
      break
    case 'text':
      // Compaction summaries are for the provider, not the user.
      if (compacting) break
      saveEntry(master, newEntry('master', { text: event.text }))
      setDraft(master, '')
      break
    // The master has no cards: it asks in its reply text and never runs
    // actions that need approval, so such requests are answered at once.
    case 'approval':
      answerAgent(agentId, event.requestId, {
        kind: 'approval',
        allow: false,
        message: 'The master cannot run this. Create a task for work in a project instead.',
      })
      break
    case 'question':
      answerAgent(agentId, event.requestId, {
        kind: 'question',
        answers: Object.fromEntries(
          event.questions.map(({ question }) => [question, 'No answer. Ask this in your reply text instead.']),
        ),
      })
      break
    case 'error':
      if (compacting) master.compactFailed = true
      saveEntry(master, newEntry('note', { text: event.message, tone: 'error' }))
      break
    case 'turn-done':
      if (compacting) {
        if (!master.compactFailed) {
          saveEntry(master, newEntry('note', { text: 'Context compacted', tone: 'info', compacted: true }))
          master.charsSinceCompact = 0
        }
        master.compactFailed = false
      } else if (master.draft.trim()) {
        saveEntry(master, newEntry('master', { text: master.draft, interrupted: Boolean(event.interrupted) || undefined }))
      }
      endTurn(master)
      break
    case 'stopped':
      if (master.draft.trim()) saveEntry(master, newEntry('master', { text: master.draft, interrupted: true }))
      endTurn(master)
      break
  }
}

function endTurn(master: Master) {
  setDraft(master, '')
  master.turnTasksId = undefined
  setStatus(master, 'idle')
  if (master.pending.length && !master.batchTimer) void flush(master)
  else scheduleCompaction(master)
}

/** Sends the batched messages as one turn once the master is free. */
async function flush(master: Master) {
  master.batchTimer = undefined
  if (master.status !== 'idle' || master.pending.length === 0) return
  const target = master.target
  if (!target) return
  const text = master.pending.join('\n\n')
  master.pending = []
  setStatus(master, 'answering')
  try {
    const agentId = await ensureAgent(master, target.provider, target.mcp)
    sendMessage(agentId, text)
  } catch (error) {
    saveEntry(master, newEntry('note', { text: error instanceof Error ? error.message : String(error), tone: 'error' }))
    setStatus(master, 'idle')
  }
}

/** When the user has been idle long enough and the chat is long, compact between turns. */
function scheduleCompaction(master: Master) {
  clearTimeout(master.idleTimer)
  const { idleCompactMs, compactChars } = masterTiming()
  if (master.charsSinceCompact < compactChars) return
  master.idleTimer = setTimeout(() => {
    master.idleTimer = undefined
    const agent = master.agentId ? getAgent(master.agentId) : undefined
    if (!agent || agent.status !== 'idle' || master.status !== 'idle' || master.pending.length) return
    if (master.charsSinceCompact < compactChars) return
    setStatus(master, 'compacting')
    master.compactFailed = false
    compactAgent(agent.id).catch((error: unknown) => {
      saveEntry(master, newEntry('note', { text: error instanceof Error ? error.message : String(error), tone: 'error' }))
      setStatus(master, 'idle')
    })
  }, idleCompactMs)
  master.idleTimer.unref?.()
}

// ---- Operations ------------------------------------------------------------------

export type SendToMasterInput = {
  folder: string
  text: string
  /** Resolves the provider for the next turn; null when none is signed in. Called after the message shows. */
  resolveProvider: () => Promise<ProviderId | null>
  mcp: McpServerInput
}

/**
 * Shows the message at once, interrupts a reply in progress, and sends the
 * message after the batch window, together with any sent within it.
 */
export async function sendToMaster({ folder, text, resolveProvider, mcp }: SendToMasterInput) {
  const master = getMaster(folder)
  await master.ready
  const trimmed = text.trim()
  if (!trimmed) return
  saveEntry(master, newEntry('user', { text: trimmed }))
  clearTimeout(master.idleTimer)
  master.idleTimer = undefined
  if (master.status === 'answering' && master.agentId) void interruptAgent(master.agentId)
  // A failed or slow sign-in probe must not lose the message while the master is alive.
  const live = master.agentId ? getAgent(master.agentId) : undefined
  const provider = (await resolveProvider().catch(() => null)) ?? live?.provider ?? null
  if (!provider) {
    saveEntry(master, newEntry('note', { text: 'No provider is signed in. Open Setup to sign in.', tone: 'error' }))
    return
  }
  master.target = { provider, mcp }
  master.pending.push(trimmed)
  clearTimeout(master.batchTimer)
  master.batchTimer = setTimeout(() => void flush(master), masterTiming().batchMs)
}

/** Adds a task the master just created to its turn's task group. */
export async function attachTaskToMaster(folder: string, task: TaskView) {
  const master = getMaster(folder)
  await master.ready
  const current = master.turnTasksId && master.entries.find(({ id }) => id === master.turnTasksId)
  if (current && current.kind === 'tasks') {
    saveEntry(master, { ...current, taskIds: [...current.taskIds, task.id] })
    return
  }
  const entry = newEntry('tasks', { taskIds: [task.id] })
  saveEntry(master, entry)
  if (master.status === 'answering') master.turnTasksId = entry.id
}

/** Sends the current chat, then every change, until the returned function is called. */
export async function subscribeToMaster(folder: string, listener: (update: MasterUpdate) => void) {
  const master = getMaster(folder)
  await master.ready
  const tasks = await listTasksAt(folder)
  listener({ type: 'reset', entries: master.entries, tasks, status: master.status, draft: master.draft })
  master.listeners.add(listener)
  return () => {
    master.listeners.delete(listener)
  }
}
