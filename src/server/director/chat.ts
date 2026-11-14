import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { directorTiming } from './context'
import { directorPrompt } from './prompt'
import { PROVIDERS } from '../providers'
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
} from '../runner/agent-runner'
import type { AgentEventEnvelope, McpServer, ProviderId } from '../runner/contract'

type McpServers = Record<string, McpServer>
import { listTasksAt, subscribeToTasks, type TaskView } from '../tasks'

// The Director: one long-lived agent per data folder that answers the user and
// creates tasks through busyboy's MCP tools. What the user sees is kept in
// its own transcript file, so it never depends on what the provider session
// still holds after compaction or a lost session.
//
//   <data>/director/transcript.jsonl   display transcript, one entry per line
//   <data>/director/state.json         provider and session id for resume
//   <data>/director/                   also the Director agent's working directory

export const DIRECTOR_FOLDER = 'director'
const TRANSCRIPT_FILE = 'transcript.jsonl'
const STATE_FILE = 'state.json'

export type ChatEntry =
  | { id: string; at: string; kind: 'user'; text: string }
  | { id: string; at: string; kind: 'director'; text: string; interrupted?: boolean }
  /** Tasks the Director created in one turn. */
  | { id: string; at: string; kind: 'tasks'; taskIds: string[] }
  | { id: string; at: string; kind: 'note'; text: string; tone: 'info' | 'error'; compacted?: boolean }

export type DirectorStatus = 'idle' | 'answering' | 'compacting'

export type DirectorUpdate =
  | { type: 'reset'; entries: ChatEntry[]; tasks: TaskView[]; status: DirectorStatus; draft: string }
  /** Appends the entry, or replaces the one with the same id. */
  | { type: 'entry'; entry: ChatEntry }
  /** The Director's reply as it streams; empty when no reply is streaming. */
  | { type: 'draft'; text: string }
  | { type: 'status'; status: DirectorStatus }
  | { type: 'task'; task: TaskView }

type DirectorState = { provider?: ProviderId; sessionId?: string }

type Director = {
  folder: string
  ready: Promise<void>
  entries: ChatEntry[]
  state: DirectorState
  agentId?: string
  /** The system prompt the running agent was started with. */
  instructions?: string
  status: DirectorStatus
  /** The reply streaming in the turn in progress: `blocks` joined, as the user sees it. */
  draft: string
  /** The turn's text blocks by item id, in the order they started. */
  blocks: Map<string, string>
  /** Messages waiting for the batch window to close. */
  pending: string[]
  /** The text of the latest turn, sent again if resuming the session fails. */
  lastSent?: string
  /** The agent was started or resumed on a stored session that the provider has not confirmed yet. */
  unconfirmedResume?: boolean
  /** The provider said the stored session does not exist; recovered when that turn or process ends. */
  lostSession?: boolean
  /** Sign-in checks in progress; their messages are queued but must wait for them. */
  probing: number
  /** Counts turns, so a turn that awaited can tell whether it is still the current one. */
  turn: number
  batchTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  /** The tasks entry of the turn in progress, so one turn's tasks share one bubble. */
  turnTasksId?: string
  charsSinceCompact: number
  /** An error arrived during the compaction in progress. */
  compactFailed?: boolean
  /** Compaction failed; it is not tried again until the user's next message. */
  compactBlocked?: boolean
  /** The user pressed Stop; the agent's `stopped` event ends the turn. */
  stopRequested?: boolean
  /** The provider and MCP endpoint from the latest message, used for the next turn. */
  target?: { provider: ProviderId; mcp: McpServers }
  writes: Promise<unknown>
  listeners: Set<(update: DirectorUpdate) => void>
}

// Kept on globalThis so `next dev` reloads keep the running director.
const DIRECTORS_KEY = Symbol.for('busyboy.directors')
const globalStore = globalThis as typeof globalThis & { [DIRECTORS_KEY]?: Map<string, Director> }
const directors = (globalStore[DIRECTORS_KEY] ??= new Map())

const directorFolder = (director: Director) => join(director.folder, DIRECTOR_FOLDER)

function getDirector(folder: string): Director {
  let director = directors.get(folder)
  if (director) return director
  director = {
    folder,
    ready: Promise.resolve(),
    entries: [],
    state: {},
    status: 'idle',
    draft: '',
    blocks: new Map(),
    pending: [],
    probing: 0,
    turn: 0,
    charsSinceCompact: 0,
    writes: Promise.resolve(),
    listeners: new Set(),
  }
  director.ready = load(director)
  subscribeToTasks(folder, (task) => broadcast(director, { type: 'task', task }))
  directors.set(folder, director)
  return director
}

async function load(director: Director) {
  const folder = directorFolder(director)
  const lines = (await readFile(join(folder, TRANSCRIPT_FILE), 'utf8').catch(() => '')).split('\n')
  const byId = new Map<string, ChatEntry>()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as unknown
      if (isEntry(entry)) byId.set(entry.id, entry)
    } catch {
      // A line cut short by a crash; skip it.
    }
  }
  director.entries = [...byId.values()]
  const lastCompaction = director.entries.findLastIndex((entry) => entry.kind === 'note' && entry.compacted)
  director.charsSinceCompact = director.entries.slice(lastCompaction + 1).reduce((sum, entry) => sum + entryLength(entry), 0)
  try {
    const state = JSON.parse(await readFile(join(folder, STATE_FILE), 'utf8')) as Partial<Record<keyof DirectorState, unknown>> | null
    director.state =
      state && PROVIDERS.some(({ id }) => id === state.provider) && typeof state.sessionId === 'string'
        ? { provider: state.provider as ProviderId, sessionId: state.sessionId as string }
        : {}
  } catch {
    // Missing or unreadable: the next message starts a new provider session.
    director.state = {}
  }
}

/** Keeps only lines this version can show; anything else in the file is skipped. */
function isEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || typeof entry.at !== 'string') return false
  switch (entry.kind) {
    case 'user':
    case 'director':
      return typeof entry.text === 'string'
    case 'note':
      return typeof entry.text === 'string' && (entry.tone === 'info' || entry.tone === 'error')
    case 'tasks':
      return Array.isArray(entry.taskIds) && entry.taskIds.every((id) => typeof id === 'string')
    default:
      return false
  }
}

function entryLength(entry: ChatEntry) {
  return entry.kind === 'user' || entry.kind === 'director' ? entry.text.length : 0
}

function broadcast(director: Director, update: DirectorUpdate) {
  for (const listener of director.listeners) listener(update)
}

function setStatus(director: Director, status: DirectorStatus) {
  if (director.status === status) return
  director.status = status
  broadcast(director, { type: 'status', status })
}

// A turn can have several text blocks, for example one before a tool call and
// one after it. Each is kept by its item id, so a block's deltas never run into
// another block and a final `text` replaces only its own block. The turn's
// reply is saved as one entry when the turn ends, blocks split by a blank line.
function setBlock(director: Director, itemId: string, text: string) {
  director.blocks.set(itemId, text)
  setDraft(director, [...director.blocks.values()].filter((block) => block.trim()).join('\n\n'))
}

function setDraft(director: Director, text: string) {
  director.draft = text
  broadcast(director, { type: 'draft', text })
}

/** Appends a new entry, or replaces the one with the same id (the file keeps the last line per id). */
function saveEntry(director: Director, entry: ChatEntry) {
  const index = director.entries.findIndex(({ id }) => id === entry.id)
  if (index === -1) {
    director.entries.push(entry)
    director.charsSinceCompact += entryLength(entry)
  } else director.entries[index] = entry
  broadcast(director, { type: 'entry', entry })
  const folder = directorFolder(director)
  director.writes = director.writes
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      await appendFile(join(folder, TRANSCRIPT_FILE), `${JSON.stringify(entry)}\n`)
    })
    .catch((error: unknown) => console.error('busyboy: could not save the Director transcript', error))
}

function newEntry<K extends ChatEntry['kind']>(kind: K, fields: Omit<Extract<ChatEntry, { kind: K }>, 'id' | 'at' | 'kind'>) {
  return { id: randomUUID(), at: new Date().toISOString(), kind, ...fields } as Extract<ChatEntry, { kind: K }>
}

function saveState(director: Director) {
  const folder = directorFolder(director)
  const state = { ...director.state }
  director.writes = director.writes
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      const file = join(folder, STATE_FILE)
      await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
      await rename(`${file}.tmp`, file)
    })
    .catch((error: unknown) => console.error('busyboy: could not save the Director state', error))
}

// ---- The Director agent ----------------------------------------------------------

async function ensureAgent(director: Director, provider: ProviderId, mcp: McpServers, instructions: string) {
  const existing = director.agentId ? getAgent(director.agentId) : undefined
  if (existing && existing.provider === provider && director.instructions === instructions) {
    if (existing.status === 'stopped') {
      director.unconfirmedResume = Boolean(existing.sessionId)
      resumeAgent(existing.id)
    }
    return existing.id
  }
  if (existing && existing.provider === provider) {
    // The prompt changed. It is fixed for a provider process, so the agent
    // restarts on the same session with the new prompt. An unchanged prompt
    // keeps the process and its prompt cache.
    director.agentId = undefined
    await stopAgent(existing.id).catch(() => {})
  } else if (existing) {
    // The default provider changed: its conversation cannot carry over.
    director.agentId = undefined
    void stopAgent(existing.id)
    saveEntry(director, newEntry('note', { text: `Started a new conversation on ${provider}.`, tone: 'info' }))
  }
  const cwd = directorFolder(director)
  await mkdir(cwd, { recursive: true })
  const resumeSessionId = director.state.provider === provider ? director.state.sessionId : undefined
  director.unconfirmedResume = Boolean(resumeSessionId)
  const agent = startAgent({ provider, cwd, instructions, mcpServers: mcp, resumeSessionId })
  director.agentId = agent.id
  director.instructions = instructions
  subscribeToAgent(agent.id, 0, (envelope) => onAgentEvent(director, agent.id, envelope))
  return agent.id
}

function onAgentEvent(director: Director, agentId: string, { event }: AgentEventEnvelope) {
  if (director.agentId !== agentId) return
  const compacting = director.status === 'compacting'
  switch (event.type) {
    case 'session':
      director.unconfirmedResume = false
      if (director.state.sessionId !== event.sessionId) {
        director.state = { provider: getAgent(agentId)?.provider, sessionId: event.sessionId }
        saveState(director)
      }
      break
    // Compaction summaries are for the provider, not the user.
    case 'text-delta':
      if (!compacting) setBlock(director, event.itemId, (director.blocks.get(event.itemId) ?? '') + event.text)
      break
    case 'text':
      if (!compacting) setBlock(director, event.itemId, event.text)
      break
    // The Director has no cards: it asks in its reply text and never runs
    // actions that need approval, so such requests are answered at once.
    // Answered after the runner has delivered the request to every listener.
    case 'approval':
      queueMicrotask(() =>
        answerAgent(agentId, event.requestId, {
          kind: 'approval',
          allow: false,
          message: 'The Director cannot run this. Create a task for work in a project instead.',
        }),
      )
      break
    case 'question':
      queueMicrotask(() =>
        answerAgent(agentId, event.requestId, {
          kind: 'question',
          answers: Object.fromEntries(
            event.questions.map(({ question }) => [question, 'No answer. Ask this in your reply text instead.']),
          ),
        }),
      )
      break
    case 'error':
      // Only a session the provider no longer has is recovered; any other
      // startup failure is shown and the stored session is kept.
      if (director.unconfirmedResume && LOST_SESSION.test(event.message)) {
        director.lostSession = true
        break
      }
      if (compacting) director.compactFailed = true
      saveEntry(director, newEntry('note', { text: event.message, tone: 'error' }))
      break
    case 'turn-done':
      if (director.lostSession) {
        recoverLostSession(director, agentId)
        break
      }
      if (compacting) {
        // An interrupted compaction (the user came back) is simply tried again later.
        if (!director.compactFailed && !event.interrupted) {
          saveEntry(director, newEntry('note', { text: 'Context compacted', tone: 'info', compacted: true }))
          director.charsSinceCompact = 0
        }
        if (director.compactFailed) director.compactBlocked = true
        director.compactFailed = false
      } else if (director.draft.trim()) {
        saveEntry(director, newEntry('director', { text: director.draft, interrupted: Boolean(event.interrupted) || undefined }))
      }
      endTurn(director)
      break
    case 'stopped':
      if (director.lostSession) {
        // A Stop wins over recovery: the session is still forgotten, but the turn is not sent again.
        recoverLostSession(director, agentId, { resend: !director.stopRequested })
        break
      }
      if (director.draft.trim()) saveEntry(director, newEntry('director', { text: director.draft, interrupted: true }))
      else if (director.stopRequested) saveEntry(director, newEntry('note', { text: 'Stopped.', tone: 'info' }))
      endTurn(director)
      break
  }
}

/** Claude's message for a resumed session it does not have (the scripted provider uses it too). */
const LOST_SESSION = /No conversation found with session ID/i

/**
 * The stored session is gone (pruned, or from another machine): forget it,
 * start a new conversation, and send the turn again instead of failing every message.
 */
function recoverLostSession(director: Director, agentId: string, { resend = true } = {}) {
  director.lostSession = false
  director.unconfirmedResume = false
  director.agentId = undefined
  void stopAgent(agentId).catch(() => {})
  director.state = {}
  saveState(director)
  saveEntry(director, newEntry('note', { text: 'The previous conversation could not be resumed. Started a new one.', tone: 'info' }))
  if (resend && director.lastSent) director.pending.unshift(director.lastSent)
  endTurn(director)
}

function endTurn(director: Director) {
  // A Stop applies to this turn only.
  director.stopRequested = false
  director.blocks.clear()
  setDraft(director, '')
  director.turnTasksId = undefined
  setStatus(director, 'idle')
  // Messages still in a sign-in check or batch window are sent when those end.
  if (director.pending.length && !director.batchTimer && !director.probing) void flush(director)
  else scheduleCompaction(director)
}

/**
 * Read through a call so TypeScript does not keep `status` narrowed to
 * 'idle' from before an await, when events may have changed it.
 */
function isAnswering(director: Director) {
  return director.status === 'answering'
}

/** Sends the batched messages as one turn once the Director is free. */
async function flush(director: Director) {
  director.batchTimer = undefined
  if (director.status !== 'idle' || director.pending.length === 0) return
  const target = director.target
  if (!target) return
  const text = director.pending.join('\n\n')
  director.pending = []
  director.lastSent = text
  setStatus(director, 'answering')
  const turn = ++director.turn
  try {
    // Read before every turn: memory or the companion may have changed since
    // the agent started.
    const instructions = await directorPrompt(director.folder)
    // Stop was pressed while the prompt was read and stopped the idle agent:
    // its stopped event already ended this turn, and a newer turn may have
    // started. This one neither restarts the agent nor sends.
    if (director.turn !== turn || !isAnswering(director)) return
    const agentId = await ensureAgent(director, target.provider, target.mcp, instructions)
    // Stop was pressed while the agent was starting: the turn is not sent.
    if (director.stopRequested && getAgent(agentId)?.status !== 'stopped') {
      saveEntry(director, newEntry('note', { text: 'Stopped.', tone: 'info' }))
      endTurn(director)
      return
    }
    // It stopped while starting: a lost session was already recovered and the
    // turn queued again, and any other failure was reported by its events.
    if (director.agentId !== agentId || getAgent(agentId)?.status === 'stopped') return
    sendMessage(agentId, text)
  } catch (error) {
    saveEntry(director, newEntry('note', { text: error instanceof Error ? error.message : String(error), tone: 'error' }))
    setStatus(director, 'idle')
  }
}

/** When the user has been idle long enough and the chat is long, compact between turns. */
function scheduleCompaction(director: Director) {
  clearTimeout(director.idleTimer)
  const { idleCompactMs, compactChars } = directorTiming()
  if (director.compactBlocked || director.charsSinceCompact < compactChars) return
  director.idleTimer = setTimeout(() => {
    director.idleTimer = undefined
    const agent = director.agentId ? getAgent(director.agentId) : undefined
    if (!agent || agent.status !== 'idle' || director.status !== 'idle' || director.pending.length) return
    if (director.charsSinceCompact < compactChars) return
    setStatus(director, 'compacting')
    director.compactFailed = false
    compactAgent(agent.id).catch((error: unknown) => {
      saveEntry(director, newEntry('note', { text: error instanceof Error ? error.message : String(error), tone: 'error' }))
      director.compactBlocked = true
      if (director.status === 'compacting') endTurn(director)
    })
  }, idleCompactMs)
  director.idleTimer.unref?.()
}

// ---- Operations ------------------------------------------------------------------

export type SendToDirectorInput = {
  folder: string
  text: string
  /**
   * Resolves the provider for the next turn, after the message shows, given the
   * provider the Director already uses. Null when no provider can be used.
   */
  resolveProvider: (current: ProviderId | undefined) => Promise<ProviderId | null>
  mcp: McpServers
}

/**
 * Shows the message at once, interrupts a reply in progress, and sends the
 * message after the batch window, together with any sent within it.
 */
export async function sendToDirector({ folder, text, resolveProvider, mcp }: SendToDirectorInput) {
  const director = getDirector(folder)
  await director.ready
  const trimmed = text.trim()
  if (!trimmed) return
  saveEntry(director, newEntry('user', { text: trimmed }))
  clearTimeout(director.idleTimer)
  director.idleTimer = undefined
  // A reply or a compaction in progress gives way to the user.
  if (director.status !== 'idle' && director.agentId) {
    interruptAgent(director.agentId).catch((error: unknown) => console.error('busyboy: could not interrupt the Director', error))
  }
  // Queued before the sign-in check, so messages keep the order they were sent in.
  director.pending.push(trimmed)
  // A failed or slow sign-in probe must not lose the message while the Director is alive.
  const live = director.agentId ? getAgent(director.agentId) : undefined
  director.probing++
  const provider = await resolveProvider(live?.provider ?? director.state.provider)
    .catch(() => null)
    .finally(() => director.probing--)
  // A turn that ended during the probe may have scheduled compaction.
  clearTimeout(director.idleTimer)
  director.idleTimer = undefined
  if (!provider) {
    // Unless a batch with an earlier message already took it to the Director.
    const index = director.pending.lastIndexOf(trimmed)
    if (index !== -1) {
      director.pending.splice(index, 1)
      saveEntry(director, newEntry('note', { text: 'No provider is signed in. Open Setup to sign in.', tone: 'error' }))
    }
    scheduleCompaction(director)
    return
  }
  director.compactBlocked = false
  director.target = { provider, mcp }
  clearTimeout(director.batchTimer)
  director.batchTimer = setTimeout(() => void flush(director), directorTiming().batchMs)
}

/**
 * Stops the Director's current turn by ending its provider process, so even a
 * provider that no longer responds stops. Messages not sent yet are dropped;
 * the next message resumes the same conversation.
 */
export async function stopDirector(folder: string) {
  const director = getDirector(folder)
  await director.ready
  clearTimeout(director.batchTimer)
  director.batchTimer = undefined
  director.pending = []
  // Only a reply can be stopped; an idle compaction is the Director's own housekeeping.
  if (director.status !== 'answering') return
  director.stopRequested = true
  // No agent yet: flush sees the flag before sending.
  const agent = director.agentId ? getAgent(director.agentId) : undefined
  if (!agent || agent.status === 'stopped') return
  try {
    await stopAgent(agent.id)
  } catch (error) {
    director.stopRequested = false
    throw error
  }
}

/** Adds a task the Director just created to its turn's task group. */
export async function attachTaskToDirector(folder: string, task: TaskView) {
  const director = getDirector(folder)
  await director.ready
  const current = director.turnTasksId && director.entries.find(({ id }) => id === director.turnTasksId)
  if (current && current.kind === 'tasks') {
    saveEntry(director, { ...current, taskIds: [...current.taskIds, task.id] })
    return
  }
  const entry = newEntry('tasks', { taskIds: [task.id] })
  saveEntry(director, entry)
  if (director.status === 'answering') director.turnTasksId = entry.id
}

/** Sends the current chat, then every change, until the returned function is called. */
export async function subscribeToDirector(folder: string, listener: (update: DirectorUpdate) => void) {
  const director = getDirector(folder)
  await director.ready
  const tasks = await listTasksAt(folder)
  listener({ type: 'reset', entries: director.entries, tasks, status: director.status, draft: director.draft })
  director.listeners.add(listener)
  return () => {
    director.listeners.delete(listener)
  }
}
