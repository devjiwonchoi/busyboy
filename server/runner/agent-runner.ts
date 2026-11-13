import { randomUUID } from 'node:crypto'
import { claudeAdapter } from './claude-adapter'
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
import { createScriptedAdapter, SCRIPTS_ENV } from './scripted-provider'

type AgentRecord = {
  id: string
  input: StartAgentInput
  status: AgentStatus
  sessionId?: string
  events: AgentEventEnvelope[]
  listeners: Set<(envelope: AgentEventEnvelope) => void>
  session: ProviderSession | null
  pending: Set<string>
  interrupting: boolean
}

type Registry = { agents: Map<string, AgentRecord> }

// Kept on globalThis: a module-level Map is re-created when `next dev` reloads
// this module, which would orphan running agent processes.
const REGISTRY_KEY = Symbol.for('busyboy.agent-runner')
const globalStore = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry }
const registry: Registry = (globalStore[REGISTRY_KEY] ??= { agents: new Map() })

/** With BUSYBOY_PROVIDER_SCRIPTS set, every provider is replaced by the scripted replay. */
function adapterFor(provider: ProviderId): ProviderAdapter {
  const scripts = process.env[SCRIPTS_ENV]
  if (scripts) return createScriptedAdapter(scripts)
  if (provider === 'claude') return claudeAdapter
  throw new Error(`The ${provider} provider is not available yet.`)
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
    case 'question':
      agent.pending.add(event.requestId)
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
      agent.status = 'idle'
      break
    case 'stopped':
      if (agent.status === 'stopped') return
      agent.status = 'stopped'
      agent.session = null
      break
  }
  if (event.type === 'turn-done' || event.type === 'stopped') {
    // Requests left open by an interrupt or stop can no longer be answered.
    for (const requestId of agent.pending) push(agent, { type: 'answered', requestId })
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
  record(agent, { type: 'started', resumed: Boolean(resumeSessionId) })
  try {
    agent.session = adapterFor(agent.input.provider).start({
      provider: agent.input.provider,
      cwd: agent.input.cwd,
      instructions: agent.input.instructions,
      permissionMode: agent.input.permissionMode ?? 'auto',
      resumeSessionId,
      mcpServers: agent.input.mcpServers,
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
    pending: new Set(),
    interrupting: false,
  }
  registry.agents.set(agent.id, agent)
  launch(agent, input.resumeSessionId)
  return snapshot(agent)
}

export function sendMessage(agentId: string, text: string) {
  const agent = getRecord(agentId)
  if (!agent.session) throw new Error('The agent is stopped. Resume it first.')
  record(agent, { type: 'user-message', text })
  if (agent.status === 'idle' || agent.status === 'starting') agent.status = 'running'
  agent.session.send(text)
}

/** Ends the current turn. The agent stays alive and waits for the next message. */
export async function interruptAgent(agentId: string) {
  const agent = getRecord(agentId)
  if (!agent.session || agent.status === 'idle') return
  agent.interrupting = true
  await agent.session.interrupt()
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
  await agent.session.compact()
}

export function answerAgent(agentId: string, requestId: string, answer: AgentAnswer) {
  const agent = getRecord(agentId)
  if (!agent.session || !agent.pending.has(requestId)) return false
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
