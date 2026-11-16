import { directorSession } from './chat'
import { getAgent, removeAgent, sendMessage, startAgent, stopAgent, subscribeToAgent } from '../runner/agent-runner'
import type { AgentEventEnvelope } from '../runner/contract'

// Side chats, like Claude Code's /btw: each one runs in a branch of the
// Director's provider session, so it sees what the main chat discussed, but
// nothing of it is written to the Director's transcript or session. The user
// can keep several open, each its own conversation. A side agent that sits
// idle ends on its own, and at most MAX_SIDE_CHATS run per data folder, so a
// reload or a lost close cannot leave processes behind for long.

// The Director's system prompt (instructions, companion voice, memory) comes
// first so the side agent knows busyboy's terms and what the user asked to be
// remembered. It is read when the side chat starts.
const SIDE_NOTE = `This conversation is a side chat beside the main one. Answer briefly from the conversation so far. You have no tools here, you cannot create tasks, and nothing you say reaches the main conversation.`

/** Side chats one data folder may run at once; a new one ends the least recently used. */
const MAX_SIDE_CHATS = 5
/** A side chat with no new question for this long ends its process, even mid-answer; the next question starts a new branch. */
const IDLE_MS = 10 * 60_000

type SideAgent = { folder: string; usedAt: number; idle?: ReturnType<typeof setTimeout> }

// On globalThis so a `next dev` reload still finds the running side agents.
// `live` holds the side agents still running; `all` holds every side agent's
// id, so the event route streams side agents and nothing else.
const SIDE_KEY = Symbol.for('busyboy.side-agents.v2')
const globalStore = globalThis as typeof globalThis & {
  [SIDE_KEY]?: { live: Map<string, SideAgent>; all: Set<string> }
}
const sideAgents = (globalStore[SIDE_KEY] ??= { live: new Map(), all: new Set() })

/**
 * How long a stopped side agent stays known. Without this each one would keep
 * its id and its full event list for the life of the server. The side chat
 * reads an answer right after asking, so a minute covers every reader.
 */
const KEEP_STOPPED_MS = 60_000

function forgetLater(agentId: string) {
  setTimeout(() => {
    sideAgents.all.delete(agentId)
    removeAgent(agentId)
  }, KEEP_STOPPED_MS).unref()
}

function endWhenIdle(agentId: string) {
  const side = sideAgents.live.get(agentId)
  if (!side) return
  clearTimeout(side.idle)
  side.idle = setTimeout(() => void stopAgent(agentId).catch(() => {}), IDLE_MS)
  side.idle.unref()
}

/** Starts a side chat in a new branch of the Director's session. */
async function startSideChat(folder: string) {
  // Branches from the session as the provider last saved it; a question asked
  // mid-turn is not covered by a journey or a recorded run.
  const { cwd, instructions, provider, sessionId } = await directorSession(folder)
  if (!provider || !sessionId) throw new Error('Start a conversation in the main chat first.')
  // The branch runs in the Director's folder: Claude finds sessions by working directory.
  const agent = startAgent({
    provider,
    cwd,
    instructions: `${instructions}\n\n${SIDE_NOTE}`,
    forkSessionId: sessionId,
    noTools: true,
  })
  // Registered right after starting, with no await between, so the cap below counts it.
  sideAgents.all.add(agent.id)
  sideAgents.live.set(agent.id, { folder, usedAt: Date.now() })
  const others = [...sideAgents.live].filter(([id, side]) => id !== agent.id && side.folder === folder)
  others.sort(([, a], [, b]) => a.usedAt - b.usedAt)
  for (const [id] of others.slice(0, Math.max(0, others.length + 1 - MAX_SIDE_CHATS))) void stopAgent(id).catch(() => {})
  let ended = false
  let unsubscribe: (() => void) | null = null
  unsubscribe = subscribeToAgent(agent.id, 0, ({ event }) => {
    if (event.type === 'turn-done') endWhenIdle(agent.id)
    if (event.type === 'stopped') {
      ended = true
      unsubscribe?.()
      clearTimeout(sideAgents.live.get(agent.id)?.idle)
      sideAgents.live.delete(agent.id)
      forgetLater(agent.id)
    }
  })
  // It may have stopped while subscribing, before `unsubscribe` was set.
  if (ended) unsubscribe?.()
  return agent.id
}

/** The error a side agent stopped with, for an agent that ended before it could answer. */
function stopError(agentId: string) {
  let message = 'The side chat could not start. Try again.'
  subscribeToAgent(agentId, 0, ({ event }) => {
    if (event.type === 'error') message = event.message
  })?.()
  return message
}

/**
 * Asks in the side chat `agentId`, or starts a new one when it is not given or
 * has ended (`restarted` then says the earlier questions are not in its
 * context). Returns the side agent's id and the last event before the
 * question, so the caller streams only this answer.
 */
export async function askSideQuestion(folder: string, text: string, agentId?: string) {
  const live = agentId ? sideAgents.live.get(agentId) : undefined
  const continues = live?.folder === folder && agentId !== undefined && getAgent(agentId)?.status !== 'stopped'
  const id = continues ? agentId : await startSideChat(folder)
  // A provider that fails to start has already recorded `stopped`; streaming after it would wait forever.
  if (getAgent(id)?.status === 'stopped') throw new Error(stopError(id))
  // Armed now as well as after each answer, so an answer that never finishes cannot keep the process.
  endWhenIdle(id)
  const side = sideAgents.live.get(id)
  if (side) side.usedAt = Date.now()
  const after = getAgent(id)?.lastSeq ?? 0
  sendMessage(id, text)
  return { agentId: id, after, restarted: agentId !== undefined && !continues }
}

/** Ends the side chat `agentId` if it belongs to this data folder. */
export async function closeSideChat(folder: string, agentId: string) {
  if (sideAgents.live.get(agentId)?.folder !== folder) return
  await stopAgent(agentId).catch(() => {})
}

/**
 * Every event of a side agent after `after`, then live events. Undefined for
 * an id that is not a side agent, so the route never streams the Director or a task.
 */
export function subscribeToSideAgent(agentId: string, after: number, listener: (envelope: AgentEventEnvelope) => void) {
  if (!sideAgents.all.has(agentId)) return undefined
  return subscribeToAgent(agentId, after, listener)
}

/** Whether the agent has stopped for good, which ends its stream. */
export function isSideAgentStopped(agentId: string) {
  return getAgent(agentId)?.status === 'stopped'
}
