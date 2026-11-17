import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendTranscriptLine, readTranscript, type TranscriptCursor } from './transcript-log'
import { alwaysAskRulesAt } from '../always-ask-list'
import { rulesFolderFor } from '../runner/user-rules'
import { pathKey, samePath } from '../paths'
import { BUSYBOY_FILES_RULE } from '../runner/always-ask'
import { directorTiming } from './context'
import { directorPrompt, managerPrompt } from './prompt'
import { getManagerAt, isListedManager, listManagersAt, subscribeToManagers } from '../managers'
import { PROVIDERS } from '../providers'
import {
  answerAgent,
  compactAgent,
  getAgent,
  interruptAgent,
  isStoppingAllAgents,
  resumeAgent,
  sendMessage,
  startAgent,
  stopAgent,
  subscribeToAgent,
} from '../runner/agent-runner'
import type { AgentEventEnvelope, McpServer, ProviderId } from '../runner/contract'
import type { AttachmentInput } from '@/lib/chat-attachments'
import { attachmentsTurn } from '../chat-attachments'
import { combineTurns, displayText, modelText, type UserTurn } from '../runner/user-turn'
import { cardRecordTitle, isStoredCardKind, type StoredCardKind } from '../cards/model'
import { closeDirectorApproval, openCards, openDirectorApproval, replyToCard, subscribeToCards, type TaskCard } from '../task-cards'
import { listTasksAt, messageTaskAt, readTasksAt, subscribeToTasks, type TaskView } from '../tasks'

type McpServers = Record<string, McpServer>

// The Director: one long-lived agent per data folder that answers the user and
// creates tasks through busyboy's MCP tools. What the user sees is kept in
// its own transcript file, so it never depends on what the provider session
// still holds after compaction or a lost session.
//
//   <data>/director/transcript.jsonl     active display transcript, one entry per line
//   <data>/director/transcript.<n>.jsonl earlier segments, oldest first, each about 20MB
//   <data>/director/state.json           provider and session id for resume
//   <data>/director/                     also the Director agent's working directory
//
// A manager (server/managers.ts) is the same kind of chat for one project, with
// its own agent, transcript, and state in <data>/managers/<manager id>/. In this
// file `chat` names one: a manager's id, or null for the Director. A task and
// its cards show in the chat of the manager that created the task, and in the
// Director's chat otherwise.

export const DIRECTOR_FOLDER = 'director'
export const MANAGERS_FOLDER = 'managers'
const STATE_FILE = 'state.json'

export type ChatEntry =
  /** `to`: the `project · task` a reply to a card went to, instead of the Director. */
  | { id: string; at: string; kind: 'user'; text: string; to?: string }
  | { id: string; at: string; kind: 'director'; text: string; interrupted?: boolean }
  /** Tasks the Director created in one turn. */
  | { id: string; at: string; kind: 'tasks'; taskIds: string[] }
  | { id: string; at: string; kind: 'note'; text: string; tone: 'info' | 'error'; compacted?: boolean }
  /** A task agent's card once it closed: what it asked and how it ended. */
  | {
      id: string
      at: string
      kind: 'card'
      cardKind: StoredCardKind
      project: string
      taskTitle: string
      title: string
      outcome: string
    }

export type DirectorStatus = 'idle' | 'answering' | 'compacting'

export type ContextUsage = { usedTokens: number; contextWindow?: number }

export type DirectorUpdate =
  | {
      type: 'reset'
      entries: ChatEntry[]
      tasks: TaskView[]
      cards: TaskCard[]
      status: DirectorStatus
      draft: string
      queue: string[]
      usage: ContextUsage | null
    }
  /** The latest context report, or null when a new conversation starts. */
  | { type: 'usage'; usage: ContextUsage | null }
  /** Appends the entry, or replaces the one with the same id. */
  | { type: 'entry'; entry: ChatEntry }
  /** Replaces the transcript, after a message is edited away. */
  | { type: 'entries'; entries: ChatEntry[] }
  /** Messages waiting to be sent after the current reply. Empty when nothing is queued. */
  | { type: 'queue'; messages: string[] }
  /** The Director's reply as it streams; empty when no reply is streaming. */
  | { type: 'draft'; text: string }
  | { type: 'status'; status: DirectorStatus }
  | { type: 'task'; task: TaskView }
  /** A task agent's card opened; it stays in the timeline until `card-closed`. */
  | { type: 'card-opened'; card: TaskCard }
  | { type: 'card-closed'; cardId: string }

type DirectorState = {
  provider?: ProviderId
  sessionId?: string
  /**
   * Set while a reply is on its way and cleared when the turn ends, so a turn
   * that BusyBoy quitting or the server dying cut off is noticed on the next start.
   */
  turnOpen?: boolean
}

/**
 * Shown after a restart cut a reply off. The user is asked to send again
 * rather than BusyBoy re-sending the turn itself: the cut-off turn may have
 * created tasks already, and sending it again could create them twice.
 */
export const REPLY_CUT_OFF_NOTE = 'BusyBoy restarted before the Director finished replying. Send your message again if you still need an answer.'

/** One line of the chat list: the Director first, then each manager. */
export type ChatSummary = {
  /** The manager's id; null for the Director. */
  chat: string | null
  name: string
  /** The manager's project; null for the Director. */
  project: string | null
  /** The start of the latest message, or empty before the first one. */
  preview: string
  status: DirectorStatus
  /** Question, approval, and plan cards waiting for the user in this chat. */
  waiting: number
}

type Director = {
  folder: string
  /** The manager this chat belongs to; null for the Director. */
  chat: string | null
  /** The manager was removed: nothing more is sent, and an agent that was just starting is ended. */
  closed?: boolean
  ready: Promise<void>
  /** `ready` has settled, so entries can be saved at once. */
  loaded: boolean
  entries: ChatEntry[]
  state: DirectorState
  agentId?: string
  /** The system prompt the running agent was started with. */
  instructions?: string
  /** The always-ask list the running agent was started with, as JSON. */
  alwaysAsk?: string
  /** The latest context report for the running session. */
  usage: ContextUsage | null
  status: DirectorStatus
  /** The reply streaming in the turn in progress: `blocks` joined, as the user sees it. */
  draft: string
  /** The turn's text blocks by item id, in the order they started. */
  blocks: Map<string, string>
  /** Messages waiting for the batch window to close. */
  pending: UserTurn[]
  /** The latest turn, sent again if resuming the session fails. */
  lastSent?: UserTurn
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
  /** Bytes in the active transcript file, so rotation does not stat on every entry. */
  transcriptFile: TranscriptCursor
  listeners: Set<(update: DirectorUpdate) => void>
}

// Kept on globalThis so `next dev` reloads keep the running director.
const DIRECTORS_KEY = Symbol.for('busyboy.directors')
const globalStore = globalThis as typeof globalThis & { [DIRECTORS_KEY]?: Map<string, Director> }
const directors = (globalStore[DIRECTORS_KEY] ??= new Map())

const directorFolder = (director: Director) =>
  director.chat ? join(director.folder, MANAGERS_FOLDER, director.chat) : join(director.folder, DIRECTOR_FOLDER)

/** One chat per data folder, whichever slash or case the folder was named with. */
const directorKey = (folder: string, chat: string | null) => (chat ? `${pathKey(folder)}\n${chat}` : pathKey(folder))

/** The chat that shows a task or card of `owner`: its manager's, or the Director's once that manager is gone from the list. */
function chatOf(folder: string, owner: string | null | undefined) {
  return owner && isListedManager(folder, owner) ? owner : null
}

const WATCHED_KEY = Symbol.for('busyboy.director-folders')
const watchedStore = globalThis as typeof globalThis & { [WATCHED_KEY]?: Set<string> }
const watched = (watchedStore[WATCHED_KEY] ??= new Set())

/** Follows a data folder's tasks and cards once, however many chats it has. */
function watchFolder(folder: string) {
  const key = pathKey(folder)
  if (watched.has(key)) return
  watched.add(key)
  // Read once, so cards are routed by the real list from the start (see isListedManager).
  void listManagersAt(folder).catch(() => {})
  subscribeToTasks(folder, (task) => {
    // Every loaded chat gets every task: a chat shows only the tasks its transcript names.
    for (const director of directors.values()) {
      if (samePath(director.folder, folder)) broadcast(director, { type: 'task', task })
    }
  })
  subscribeToCards(folder, (update) => {
    // The owning chat is loaded here if it was not yet, so a card that closes
    // before its chat was ever opened is still written to that transcript.
    const director = getDirector(folder, chatOf(folder, update.card.chat))
    if (update.type === 'open') {
      broadcast(director, { type: 'card-opened', card: update.card })
      return
    }
    const { card, outcome } = update
    broadcast(director, { type: 'card-closed', cardId: card.id })
    const title = cardRecordTitle(card)
    const save = () =>
      saveEntry(director, newEntry('card', { cardKind: card.kind, project: card.project, taskTitle: card.taskTitle, title, outcome }))
    // Saved at once when loaded, so a reply to the card (saved right after it closes) follows it in the transcript.
    if (director.loaded) {
      save()
    } else {
      void director.ready.then(save)
    }
  })
}

/** The open cards that show in this chat. */
function cardsOf(director: Director) {
  return openCards(director.folder).filter((card) => chatOf(director.folder, card.chat) === director.chat)
}

function getDirector(folder: string, chat: string | null = null): Director {
  const key = directorKey(folder, chat)
  let director = directors.get(key)
  if (director) return director
  director = {
    folder,
    chat,
    ready: Promise.resolve(),
    loaded: false,
    entries: [],
    state: {},
    status: 'idle',
    draft: '',
    blocks: new Map(),
    pending: [],
    probing: 0,
    turn: 0,
    charsSinceCompact: 0,
    usage: null,
    writes: Promise.resolve(),
    transcriptFile: {},
    listeners: new Set(),
  }
  director.ready = load(director).finally(() => {
    director.loaded = true
  })
  directors.set(key, director)
  watchFolder(folder)
  return director
}

/** What the user calls the agent of this chat in notes. */
const roleOf = (director: Director) => (director.chat ? 'manager' : 'Director')

/** The chat's system prompt. A manager that was removed meanwhile has none. */
async function promptOf(director: Director) {
  if (!director.chat) return directorPrompt(director.folder)
  const manager = await getManagerAt(director.folder, director.chat)
  if (!manager) throw new Error('This manager was removed.')
  return managerPrompt(director.folder, manager)
}

async function load(director: Director) {
  const folder = directorFolder(director)
  const lines = (await readTranscript(folder).catch(() => '')).split('\n')
  const byId = new Map<string, ChatEntry>()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      // A later removal drops the entry, including one that lived in an older segment.
      if (isRemoval(value)) {
        byId.delete(value.id)
        continue
      }
      if (isEntry(value)) byId.set(value.id, value)
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
    if (state?.turnOpen === true) {
      const text = director.chat ? REPLY_CUT_OFF_NOTE.replace('the Director', 'the manager') : REPLY_CUT_OFF_NOTE
      saveEntry(director, newEntry('note', { text, tone: 'info' }))
      saveState(director)
    }
  } catch {
    // Missing or unreadable: the next message starts a new provider session.
    director.state = {}
  }
}

/** A transcript line that drops an entry. Appended so rotated segments do not bring it back. */
function isRemoval(value: unknown): value is { id: string; kind: 'removed' } {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return entry.kind === 'removed' && typeof entry.id === 'string'
}

/** Keeps only lines this version can show; anything else in the file is skipped. */
function isEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || typeof entry.at !== 'string') return false
  switch (entry.kind) {
    case 'user':
      return typeof entry.text === 'string' && (entry.to === undefined || typeof entry.to === 'string')
    case 'director':
      return typeof entry.text === 'string'
    case 'card':
      return (
        isStoredCardKind(entry.cardKind) &&
        ['project', 'taskTitle', 'title', 'outcome'].every((key) => typeof entry[key] === 'string')
      )
    case 'note':
      return typeof entry.text === 'string' && (entry.tone === 'info' || entry.tone === 'error')
    case 'tasks':
      return Array.isArray(entry.taskIds) && entry.taskIds.every((id) => typeof id === 'string')
    default:
      return false
  }
}

/** What the Director's own conversation grew by; replies to task agents never reached it. */
function entryLength(entry: ChatEntry) {
  if (entry.kind === 'user') {
    return entry.to ? 0 : entry.text.length
  }
  return entry.kind === 'director' ? entry.text.length : 0
}

function broadcast(director: Director, update: DirectorUpdate) {
  for (const listener of director.listeners) listener(update)
}

function noteQueue(director: Director) {
  broadcast(director, { type: 'queue', messages: director.pending.map((turn) => displayText(turn)) })
}

function recount(director: Director) {
  const lastCompaction = director.entries.findLastIndex((entry) => entry.kind === 'note' && entry.compacted)
  director.charsSinceCompact = director.entries.slice(lastCompaction + 1).reduce((sum, entry) => sum + entryLength(entry), 0)
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

/** Appends a new entry, or replaces the one with the same id (a later line, including one in a newer segment, wins). */
/** Drops an entry from future reads without rewriting rotated transcript segments. */
function rememberRemoval(director: Director, id: string) {
  const folder = directorFolder(director)
  const line = `${JSON.stringify({ id, at: new Date().toISOString(), kind: 'removed' })}\n`
  director.writes = director.writes
    .catch(() => {})
    .then(() => appendTranscriptLine(folder, line, director.transcriptFile))
    .catch((error: unknown) => console.error(`busyboy: could not save the ${roleOf(director)} transcript`, error))
}

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
    .then(() => appendTranscriptLine(folder, `${JSON.stringify(entry)}\n`, director.transcriptFile))
    .catch((error: unknown) => console.error(`busyboy: could not save the ${roleOf(director)} transcript`, error))
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

async function ensureAgent(director: Director, provider: ProviderId, mcp: McpServers, instructions: string, alwaysAsk: string[]) {
  const existing = director.agentId ? getAgent(director.agentId) : undefined
  const sameSetup = director.instructions === instructions && director.alwaysAsk === JSON.stringify(alwaysAsk)
  if (existing && existing.provider === provider && sameSetup) {
    if (existing.status === 'stopped') {
      director.unconfirmedResume = Boolean(existing.sessionId)
      resumeAgent(existing.id)
    }
    return existing.id
  }
  if (existing && existing.provider === provider) {
    // The prompt or the always-ask list changed. Both are fixed for a provider process, so the
    // agent restarts on the same session with the new ones. An unchanged prompt
    // keeps the process and its prompt cache.
    director.agentId = undefined
    await stopAgent(existing.id).catch(() => {})
  } else if (existing) {
    // The harness changed: its conversation cannot carry over.
    director.agentId = undefined
    director.usage = null
    broadcast(director, { type: 'usage', usage: null })
    void stopAgent(existing.id)
    saveEntry(director, newEntry('note', { text: `Started a new conversation on ${provider}.`, tone: 'info' }))
  }
  const cwd = directorFolder(director)
  await mkdir(cwd, { recursive: true })
  const resumeSessionId = director.state.provider === provider ? director.state.sessionId : undefined
  director.unconfirmedResume = Boolean(resumeSessionId)
  // The Director gets the always-ask list too. A connector write waits for the user (see onAgentEvent).
  // Every other match is refused, so the Director never runs it, even where Auto mode would.
  // Its folder is inside BusyBoy's data folder, next to the task list and settings, so the rest
  // of the data folder is private: changing BusyBoy's state goes through BusyBoy's tools.
  const agent = startAgent({
    provider,
    cwd,
    instructions,
    mcpServers: mcp,
    resumeSessionId,
    alwaysAsk,
    privateFolder: director.folder,
    rulesFolder: rulesFolderFor(director.folder),
  })
  director.agentId = agent.id
  director.instructions = instructions
  director.alwaysAsk = JSON.stringify(alwaysAsk)
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
        director.state = { ...director.state, provider: getAgent(agentId)?.provider, sessionId: event.sessionId }
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
    // A connector write waits on a card. Other approvals are refused: the Director
    // does not edit BusyBoy's files or run project work itself.
    case 'approval':
      if (event.title.startsWith('mcp__') && !event.detail?.startsWith(BUSYBOY_FILES_RULE)) {
        openDirectorApproval({ folder: director.folder, chat: director.chat, agentId, event })
        break
      }
      queueMicrotask(() =>
        answerAgent(agentId, event.requestId, {
          kind: 'approval',
          allow: false,
          message: event.detail?.startsWith(BUSYBOY_FILES_RULE)
            ? `The ${roleOf(director)} cannot touch BusyBoy's own files. Use BusyBoy's tools to read or change tasks and settings.`
            : `The ${roleOf(director)} cannot run this. Create a task for work in a project instead.`,
        }),
      )
      break
    case 'answered':
      closeDirectorApproval(director.folder, agentId, event.requestId)
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
      if (director.unconfirmedResume && (event.code === 'lost-session' || LOST_SESSION.test(event.message))) {
        director.lostSession = true
        break
      }
      if (compacting) director.compactFailed = true
      saveEntry(director, newEntry('note', { text: event.message, tone: 'error' }))
      break
    case 'turn-done':
      closeDirectorApproval(director.folder, agentId)
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
    case 'usage':
      director.usage = { usedTokens: event.usedTokens, ...(event.contextWindow ? { contextWindow: event.contextWindow } : {}) }
      broadcast(director, { type: 'usage', usage: director.usage })
      break
    case 'stopped':
      closeDirectorApproval(director.folder, agentId)
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

/**
 * Claude's message for a resumed session it does not have (the scripted
 * provider uses it too). Codex reports the `lost-session` code instead.
 */
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
  // The session is forgotten, but a turn still waiting for its reply stays open.
  director.state = { turnOpen: director.state.turnOpen }
  saveState(director)
  saveEntry(director, newEntry('note', { text: 'The previous conversation could not be resumed. Started a new one.', tone: 'info' }))
  if (resend && director.lastSent) {
    director.pending.unshift(director.lastSent)
    noteQueue(director)
  }
  endTurn(director)
}

/** Saves whether a message is waiting for the Director's reply; see `turnOpen`. */
function markTurnOpen(director: Director, open: boolean) {
  if (Boolean(director.state.turnOpen) === open) return
  director.state = { ...director.state, turnOpen: open || undefined }
  saveState(director)
}

function endTurn(director: Director) {
  // A turn ended by quitting stays open on disk, so the next start can say it
  // was cut off. Messages still queued keep it open for their own turn.
  if (!isStoppingAllAgents() && director.pending.length === 0) markTurnOpen(director, false)
  // A Stop applies to this turn only.
  director.stopRequested = false
  director.blocks.clear()
  setDraft(director, '')
  director.turnTasksId = undefined
  setStatus(director, 'idle')
  // Messages still in a sign-in check or batch window are sent when those end. While quitting they
  // stay queued in the open turn rather than starting an agent the stop pass already missed.
  if (isStoppingAllAgents()) return
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
  const outgoing = combineTurns(director.pending)
  director.pending = []
  noteQueue(director)
  director.lastSent = outgoing
  setStatus(director, 'answering')
  const turn = ++director.turn
  try {
    // Read before every turn: memory or the companion may have changed since
    // the agent started.
    const [instructions, alwaysAsk] = await Promise.all([promptOf(director), alwaysAskRulesAt(director.folder)])
    // Stop was pressed while the prompt was read and stopped the idle agent:
    // its stopped event already ended this turn, and a newer turn may have
    // started. This one neither restarts the agent nor sends.
    if (director.turn !== turn || !isAnswering(director)) return
    const agentId = await ensureAgent(director, target.provider, target.mcp, instructions, alwaysAsk)
    if (director.closed) {
      director.agentId = undefined
      void stopAgent(agentId).catch(() => {})
      return
    }
    // Stop was pressed while the agent was starting: the turn is not sent.
    if (director.stopRequested && getAgent(agentId)?.status !== 'stopped') {
      saveEntry(director, newEntry('note', { text: 'Stopped.', tone: 'info' }))
      endTurn(director)
      return
    }
    // It stopped while starting: a lost session was already recovered and the
    // turn queued again, and any other failure was reported by its events.
    if (director.agentId !== agentId || getAgent(agentId)?.status === 'stopped') return
    sendMessage(agentId, outgoing)
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
  /** The manager to send to; leave out for the Director. */
  chat?: string | null
  text: string
  attachments?: AttachmentInput[]
  /**
   * Resolves the provider for the next turn, after the message shows, given the
   * provider the Director already uses. Null when no provider can be used.
   */
  resolveProvider: (current: ProviderId | undefined) => Promise<ProviderId | null>
  mcp: McpServers
}

/**
 * Shows the message at once. A reply in progress keeps going and the message
 * waits, visible as the queue, until the turn ends (or Send now interrupts).
 * While the Director is idle, messages sent inside the batch window go out
 * together as one turn.
 */
export async function sendToDirector({ folder, chat, text, attachments, resolveProvider, mcp }: SendToDirectorInput) {
  const director = getDirector(folder, chat ?? null)
  await director.ready
  const turn = await attachmentsTurn({ folder: directorFolder(director), text, attachments: attachments ?? [] })
  const shown = displayText(turn)
  if (!shown) return
  saveEntry(director, newEntry('user', { text: shown }))
  clearTimeout(director.idleTimer)
  director.idleTimer = undefined
  // Compaction gives way to the user. A reply keeps going: the message waits and is sent when
  // the turn ends, unless the user chooses Send now.
  if (director.status === 'compacting' && director.agentId) {
    interruptAgent(director.agentId).catch((error: unknown) => console.error('busyboy: could not interrupt the Director', error))
  }
  // Queued before the sign-in check, so messages keep the order they were sent in.
  director.pending.push(turn)
  noteQueue(director)
  // Open from the moment a message waits for a reply, so a Quit during the
  // batch window or the sign-in check is noticed on the next start too.
  markTurnOpen(director, true)
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
    const index = director.pending.lastIndexOf(turn)
    if (index !== -1) {
      director.pending.splice(index, 1)
      noteQueue(director)
      saveEntry(director, newEntry('note', { text: 'No provider is signed in. Open Setup to sign in.', tone: 'error' }))
      if (director.status === 'idle' && director.pending.length === 0) markTurnOpen(director, false)
    }
    scheduleCompaction(director)
    return
  }
  director.compactBlocked = false
  director.target = { provider, mcp }
  // A batch timer started now would also stop endTurn from sending the queue when the reply
  // finishes (endTurn waits while a timer is set). The reply's end sends it.
  if (director.status === 'answering') return
  clearTimeout(director.batchTimer)
  director.batchTimer = setTimeout(() => void flush(director), directorTiming().batchMs)
}

/**
 * Interrupts the current reply and sends the queued messages now. While the
 * Director is idle, sends whatever is still waiting for the batch window.
 */
export async function sendDirectorQueueNow(folder: string, chat: string | null = null) {
  const director = getDirector(folder, chat)
  await director.ready
  if (director.pending.length === 0 || director.closed) return
  clearTimeout(director.batchTimer)
  director.batchTimer = undefined
  clearTimeout(director.idleTimer)
  director.idleTimer = undefined
  if (isAnswering(director) && director.agentId) {
    const agentId = director.agentId
    const agent = getAgent(agentId)
    if (agent && agent.status !== 'stopped') {
      await interruptAgent(agentId)
      // A turn that was not actually running never ends on interrupt; send once it is idle.
      // Read status through isAnswering: the await lets events change it.
      if (!isAnswering(director) && !director.probing) void flush(director)
      return
    }
  }
  if (!director.probing) void flush(director)
}

/**
 * Replaces the latest message to this chat and everything the turn said after
 * it, then sends `text`. Task and card rows stay: the chat only shows tasks
 * its transcript names. Refused while a reply or a queued send is in progress.
 */
export async function reviseDirectorMessage(input: SendToDirectorInput & { entryId: string }) {
  const director = getDirector(input.folder, input.chat ?? null)
  await director.ready
  if (director.closed) return
  if (director.status !== 'idle' || director.pending.length > 0) {
    throw new Error('Wait for the reply to finish before editing.')
  }
  const index = director.entries.findIndex((entry) => entry.id === input.entryId)
  const entry = director.entries[index]
  if (!entry || entry.kind !== 'user' || entry.to) throw new Error('That message cannot be edited.')
  const last = director.entries.findLast((item) => item.kind === 'user' && !item.to)
  if (!last || last.id !== entry.id) throw new Error('Only the latest message can be edited.')
  const removed: ChatEntry[] = []
  const kept: ChatEntry[] = []
  director.entries.forEach((item, itemIndex) => {
    if (itemIndex >= index && item.kind !== 'tasks' && item.kind !== 'card') removed.push(item)
    else kept.push(item)
  })
  director.entries = kept
  recount(director)
  for (const item of removed) rememberRemoval(director, item.id)
  broadcast(director, { type: 'entries', entries: director.entries })
  await sendToDirector(input)
}

/**
 * Stops the Director's current turn by ending its provider process, so even a
 * provider that no longer responds stops. Messages not sent yet are dropped;
 * the next message resumes the same conversation.
 */
export async function stopDirector(folder: string, chat: string | null = null) {
  const director = getDirector(folder, chat)
  await director.ready
  clearTimeout(director.batchTimer)
  director.batchTimer = undefined
  director.pending = []
  noteQueue(director)
  // Only a reply can be stopped; an idle compaction is the Director's own housekeeping.
  if (director.status !== 'answering') {
    markTurnOpen(director, false)
    return
  }
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

/**
 * Sends a reply from the composer to the task agent behind an open card. It
 * shows in the chat as the user's message, marked with where it went, and is
 * never sent to the Director.
 */
export async function replyToTaskCard({
  folder,
  cardId,
  text,
  attachments,
}: {
  folder: string
  cardId: string
  text: string
  attachments?: AttachmentInput[]
}) {
  const card = openCards(folder).find(({ id }) => id === cardId)
  // The reply shows where its card does.
  const director = getDirector(folder, chatOf(folder, card?.chat))
  await director.ready
  const task = card ? (await readTasksAt(folder)).find(({ id }) => id === card.taskId) : undefined
  const turn = await attachmentsTurn({ folder: task?.worktree ?? directorFolder(director), text, attachments: attachments ?? [] })
  const shown = displayText(turn)
  if (!shown) return
  const imagePaths = turn.images.map((image) => `Attached image: ${image.path}`).join('\n')
  replyToCard({ folder, cardId, text: [modelText(turn), imagePaths].filter(Boolean).join('\n') })
  if (card) {
    saveEntry(director, newEntry('user', { text: shown, to: `${card.project} · ${card.taskTitle}` }))
  }
}

/**
 * Sends a message from the composer to a task's agent, starting the agent again when it has
 * ended. Like a card reply, it shows in the chat marked with where it went and never reaches
 * the Director.
 */
export async function sendToTask({
  folder,
  taskId,
  text,
  attachments,
}: {
  folder: string
  taskId: string
  text: string
  attachments?: AttachmentInput[]
}) {
  const { view, shown } = await messageTaskAt(folder, taskId, { text, attachments })
  // The message shows in the chat that shows the task.
  const director = getDirector(folder, chatOf(folder, view.chat))
  await director.ready
  saveEntry(director, newEntry('user', { text: shown, to: `${view.project} · ${view.title}` }))
}

/** Adds a task the Director, or the manager `chat`, just created to its turn's task group. */
export async function attachTaskToDirector(folder: string, task: TaskView, chat: string | null = null) {
  const director = getDirector(folder, chat)
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
export async function subscribeToDirector(folder: string, listener: (update: DirectorUpdate) => void, chat: string | null = null) {
  const director = getDirector(folder, chat)
  await director.ready
  const tasks = await listTasksAt(folder)
  listener({
    type: 'reset',
    entries: director.entries,
    tasks,
    cards: cardsOf(director),
    status: director.status,
    draft: director.draft,
    queue: director.pending.map((turn) => displayText(turn)),
    usage: director.usage,
  })
  director.listeners.add(listener)
  return () => {
    director.listeners.delete(listener)
  }
}

/**
 * The Director's provider session, working directory, and system prompt, so a
 * side question can branch from the conversation. No session yet when the
 * Director never answered.
 */
export async function directorSession(
  folder: string,
  chat: string | null = null,
): Promise<{
  cwd: string
  instructions: string
  provider?: ProviderId
  sessionId?: string
}> {
  const director = getDirector(folder, chat)
  await director.ready
  return { cwd: directorFolder(director), instructions: await promptOf(director), ...director.state }
}

// ---- The chat list ----------------------------------------------------------------

const PREVIEW_LENGTH = 120

function previewOf(director: Director) {
  const last = director.entries.findLast((entry) => entry.kind === 'user' || entry.kind === 'director')
  const text = last && 'text' in last ? last.text.replace(/\s+/g, ' ').trim() : ''
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text
}

async function chatSummaries(folder: string): Promise<{ chats: ChatSummary[]; directors: Director[] }> {
  const managers = await listManagersAt(folder)
  const all = [getDirector(folder), ...managers.map(({ id }) => getDirector(folder, id))]
  await Promise.all(all.map(({ ready }) => ready))
  const chats = all.map((director, index) => ({
    chat: director.chat,
    name: index === 0 ? '' : managers[index - 1].name,
    project: index === 0 ? null : managers[index - 1].project,
    preview: previewOf(director),
    status: director.status,
    // A progress, done, or pull-request card is the task reporting. Only a question, an approval, or a plan waits on the user.
    waiting: cardsOf(director).filter((card) => card.kind === 'question' || card.kind === 'approval' || card.kind === 'plan').length,
  }))
  return { chats, directors: all }
}

/**
 * Sends the chat list (the Director, then every manager), and sends it again
 * whenever a chat gets a message, changes status, opens or closes a card, or a
 * manager is created or removed, until the returned function is called.
 */
export async function subscribeToChats(folder: string, listener: (chats: ChatSummary[]) => void) {
  let closed = false
  let following: Director[] = []
  let queued = false
  const onUpdate = (update: DirectorUpdate) => {
    // A streaming reply, the send queue, and task status changes do not show in the list.
    if (update.type === 'draft' || update.type === 'task' || update.type === 'queue') return
    refresh()
  }
  const send = async () => {
    queued = false
    const { chats, directors: current } = await chatSummaries(folder)
    if (closed) return
    for (const director of following) director.listeners.delete(onUpdate)
    following = current
    for (const director of following) director.listeners.add(onUpdate)
    listener(chats)
  }
  // Several updates in one tick (a card closing writes an entry too) send the list once.
  const refresh = () => {
    if (queued || closed) return
    queued = true
    queueMicrotask(() => void send().catch((error: unknown) => console.error('busyboy: could not read the chat list', error)))
  }
  const unsubscribe = subscribeToManagers(folder, refresh)
  await send()
  return () => {
    closed = true
    unsubscribe()
    for (const director of following) director.listeners.delete(onUpdate)
  }
}

/**
 * Shows the tasks of a removed manager in the Director's chat: a chat shows only
 * the tasks its transcript names, and the manager's transcript is no longer shown.
 */
export async function adoptTasks(folder: string, taskIds: string[]) {
  if (taskIds.length === 0) return
  const director = getDirector(folder)
  await director.ready
  saveEntry(director, newEntry('tasks', { taskIds }))
}

/** Ends the agent of a removed manager. Its transcript stays on disk. */
export async function closeChat(folder: string, chat: string) {
  const key = directorKey(folder, chat)
  const director = directors.get(key)
  if (!director) return
  director.closed = true
  clearTimeout(director.batchTimer)
  clearTimeout(director.idleTimer)
  director.pending = []
  const agentId = director.agentId
  director.agentId = undefined
  if (agentId) await stopAgent(agentId).catch(() => {})
  directors.delete(key)
}
