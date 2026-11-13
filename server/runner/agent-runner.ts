import { randomUUID } from 'node:crypto'
import { SERVER_TOKEN_ENV } from '@/lib/server-token'
import { claudeAdapter } from './claude-adapter'
import { codexAdapter } from './codex-adapter'
import type {
  AgentAnswer,
  AgentEvent,
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStatus,
  ProviderAdapter,
  ProviderId,
  ProviderSession,
  SignInStatus,
  StartAgentInput,
} from './contract'
import { createScriptedAdapter, hasScripts, SCRIPTS_ENV } from './scripted-provider'

type AgentRecord = {
  id: string
  input: StartAgentInput
  status: AgentStatus
  sessionId?: string
  events: AgentEventEnvelope[]
  listeners: Set<(envelope: AgentEventEnvelope) => void>
  session: ProviderSession | null
  /** Open approvals and questions by request id, with the answer kind each takes. */
  pending: Map<string, AgentAnswer['kind']>
  /** Set by interruptAgent while a turn runs; cleared when that turn ends or the process stops. */
  interrupting: boolean
  /** Messages sent while a turn ran; each one starts its own turn when the previous turn ends. */
  queued: number
}

type Registry = { agents: Map<string, AgentRecord> }

// Kept on globalThis: a module-level Map is re-created when `next dev` reloads
// this module, which would orphan running agent processes.
const REGISTRY_KEY = Symbol.for('busyboy.agent-runner')
const globalStore = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry }
const registry: Registry = (globalStore[REGISTRY_KEY] ??= { agents: new Map() })

/**
 * With BUSYBOY_PROVIDER_SCRIPTS set, each provider that has a script in that
 * folder is replaced by the scripted replay. The desktop app always starts the
 * server with a token, so a token means a real install and the variable is ignored.
 */
function adapterFor(provider: ProviderId): ProviderAdapter {
  const scripts = process.env[SCRIPTS_ENV]
  if (scripts && !process.env[SERVER_TOKEN_ENV] && hasScripts(scripts, provider)) return createScriptedAdapter(scripts)
  return provider === 'codex' ? codexAdapter : claudeAdapter
}

function getRecord(agentId: string) {
  const record = registry.agents.get(agentId)
  if (!record) throw new Error(`Unknown agent ${agentId}.`)
  return record
}

function snapshot(record: AgentRecord): AgentSnapshot {
  return {
    id: record.id,
    provider: record.input.provider,
    cwd: record.input.cwd,
    permissionMode: record.input.permissionMode ?? 'auto',
    status: record.status,
    sessionId: record.sessionId,
    lastSeq: record.events.length,
  }
}

function record(agent: AgentRecord, event: AgentEvent) {
  // An interrupted turn ends with an "aborted" error from the provider; it is expected.
  if (agent.interrupting && event.type === 'error' && event.code === 'provider') return
  switch (event.type) {
    case 'started':
      agent.status = 'starting'
      break
    case 'session':
      agent.sessionId = event.sessionId
      break
    case 'approval':
      agent.pending.set(event.requestId, 'approval')
      agent.status = 'waiting'
      break
    case 'question':
      agent.pending.set(event.requestId, 'question')
      agent.status = 'waiting'
      break
    case 'answered':
      agent.pending.delete(event.requestId)
      if (agent.status === 'waiting' && agent.pending.size === 0) agent.status = 'running'
      break
    case 'turn-done':
      if (agent.interrupting) {
        event = { ...event, interrupted: true }
        agent.interrupting = false
      }
      // A queued message starts its turn right away, so the agent keeps running (and can be interrupted).
      if (agent.queued > 0) {
        agent.queued -= 1
        agent.status = 'running'
      } else agent.status = 'idle'
      break
    case 'stopped':
      if (agent.status === 'stopped') return
      agent.interrupting = false
      agent.queued = 0
      agent.status = 'stopped'
      agent.session = null
      break
  }
  if (event.type === 'turn-done' || event.type === 'stopped') {
    // Requests left open by an interrupt or stop can no longer be answered.
    for (const requestId of agent.pending.keys()) push(agent, { type: 'answered', requestId })
    agent.pending.clear()
  }
  push(agent, event)
}

function push(agent: AgentRecord, event: AgentEvent) {
  const envelope: AgentEventEnvelope = { seq: agent.events.length + 1, at: Date.now(), agentId: agent.id, event }
  agent.events.push(envelope)
  for (const listener of agent.listeners) listener(envelope)
}

function launch(agent: AgentRecord, resumeSessionId?: string) {
  agent.status = 'starting'
  agent.interrupting = false
  agent.queued = 0
  record(agent, { type: 'started', resumed: Boolean(resumeSessionId) })
  try {
    agent.session = adapterFor(agent.input.provider).start({
      provider: agent.input.provider,
      cwd: agent.input.cwd,
      instructions: agent.input.instructions,
      permissionMode: agent.input.permissionMode ?? 'auto',
      resumeSessionId,
      emit: (event) => record(agent, event),
    })
    if (agent.status === 'starting') agent.status = 'idle'
  } catch (error) {
    record(agent, { type: 'error', message: error instanceof Error ? error.message : String(error), code: 'provider' })
    record(agent, { type: 'stopped', finished: false })
  }
}

// ---- Operations ------------------------------------------------------------

export function startAgent(input: StartAgentInput): AgentSnapshot {
  const agent: AgentRecord = {
    id: randomUUID(),
    input: { ...input, permissionMode: input.permissionMode ?? 'auto' },
    status: 'starting',
    events: [],
    listeners: new Set(),
    session: null,
    pending: new Map(),
    interrupting: false,
    queued: 0,
  }
  registry.agents.set(agent.id, agent)
  launch(agent, input.resumeSessionId)
  return snapshot(agent)
}

export function sendMessage(agentId: string, text: string) {
  const agent = getRecord(agentId)
  if (!agent.session) throw new Error('The agent is stopped. Resume it first.')
  record(agent, { type: 'user-message', text })
  if (agent.status === 'running' || agent.status === 'waiting') agent.queued += 1
  else agent.status = 'running'
  agent.session.send(text)
}

/** Ends the current turn. The agent stays alive and waits for the next message. */
export async function interruptAgent(agentId: string) {
  const agent = getRecord(agentId)
  // Only a running turn can be interrupted; otherwise the flag would mark a later turn.
  if (!agent.session || (agent.status !== 'running' && agent.status !== 'waiting')) return
  agent.interrupting = true
  try {
    await agent.session.interrupt()
  } catch (error) {
    agent.interrupting = false
    throw error
  }
}

export async function stopAgent(agentId: string) {
  const agent = getRecord(agentId)
  if (!agent.session) return
  await agent.session.stop()
}

/** Starts a stopped agent again on the same provider session. */
export function resumeAgent(agentId: string): AgentSnapshot {
  const agent = getRecord(agentId)
  if (agent.session) return snapshot(agent)
  launch(agent, agent.sessionId ?? agent.input.resumeSessionId)
  return snapshot(agent)
}

export async function compactAgent(agentId: string) {
  const agent = getRecord(agentId)
  if (!agent.session) throw new Error('The agent is stopped.')
  if (agent.status === 'idle') agent.status = 'running'
  await agent.session.compact()
}

/**
 * Answers an open approval or question. Returns false when it is no longer open;
 * throws when the answer kind does not match the request.
 */
export function answerAgent(agentId: string, requestId: string, answer: AgentAnswer) {
  const agent = getRecord(agentId)
  const kind = agent.pending.get(requestId)
  if (!agent.session || !kind) return false
  if (kind !== answer.kind) throw new Error(`Request ${requestId} takes an answer of kind ${kind}, not ${answer.kind}.`)
  agent.session.answer(requestId, answer)
  record(agent, { type: 'answered', requestId })
  return true
}

export function getAgent(agentId: string): AgentSnapshot | undefined {
  const agent = registry.agents.get(agentId)
  return agent && snapshot(agent)
}

export function listAgents(): AgentSnapshot[] {
  return [...registry.agents.values()].map(snapshot)
}

/**
 * Replays events after `afterSeq`, then delivers new ones as they happen.
 * Returns the unsubscribe function, or null for an unknown agent.
 */
export function subscribeToAgent(
  agentId: string,
  afterSeq: number,
  listener: (envelope: AgentEventEnvelope) => void,
): (() => void) | null {
  const agent = registry.agents.get(agentId)
  if (!agent) return null
  for (const envelope of agent.events.slice(Math.max(0, afterSeq))) listener(envelope)
  agent.listeners.add(listener)
  return () => agent.listeners.delete(listener)
}

export function providerSignInStatus(provider: ProviderId): Promise<SignInStatus> {
  return adapterFor(provider).signInStatus()
}
