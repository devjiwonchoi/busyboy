// Replays recorded provider runs with no model call. When
// BUSYBOY_PROVIDER_SCRIPTS points at a folder of `*.json` scripts (tests do
// this), it replaces each provider that has at least one script there; other
// providers keep their real adapter (for example one pointed at a fake CLI).
// See `ProviderScript` for the format.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { alwaysAskApproval, matchAlwaysAsk } from './always-ask'
import {
  ClaudeEventMapper,
  claudePermissionToEvent,
  type ClaudePermissionRequest,
  type ClaudeRawMessage,
} from './claude-events'
import type {
  AgentAnswer,
  AgentEvent,
  McpServer,
  ProviderAdapter,
  ProviderId,
  ProviderSession,
  ProviderStartOptions,
} from './contract'

export const SCRIPTS_ENV = 'BUSYBOY_PROVIDER_SCRIPTS'

/** Resuming a session id with this prefix fails, like a session the provider no longer has. */
export const MISSING_SESSION_PREFIX = 'missing-'

/**
 * One step of a scripted turn.
 * - `event`: a normalized contract event, emitted as is.
 * - `raw`: a message in the script provider's own format, mapped by that provider's
 *   mapper in `RAW_MAPPERS` (a new provider adds its mapper there).
 *   A Claude `tool_use` block named `mcp__<server>__<tool>`, where `<server>` is one of the
 *   session's HTTP `mcpServers`, really calls that tool, so a replay runs busyboy's own tool code.
 * - `canUseTool`: a recorded Claude permission request, mapped to an approval or question
 *   (Claude scripts only).
 * - `delayMs`: wait before the next step.
 * - `echoInstructions`: reply with the instructions the agent was started with, so a
 *   journey can check what reached the prompt (for example memory).
 * - `writeInstructions`: write those instructions to this file in the agent's working
 *   folder, for an agent whose replies no screen shows yet (a task agent).
 * An approval or question (from `event` or `canUseTool`) pauses the replay until it is
 * answered. With `then`, the branch named by the answer replaces the rest of the turn:
 * `allow` or `deny` for an approval, the chosen label of the first question for a question.
 */
export type ScriptStep =
  | { event: AgentEvent; then?: Record<string, ScriptStep[]> }
  | { raw: unknown }
  | { canUseTool: ClaudePermissionRequest; then?: Record<string, ScriptStep[]> }
  | { delayMs: number }
  | { echoInstructions: true }
  | { writeInstructions: string }
  | { writeFile: { path: string; text: string } }
  | { toolCall: { name: string; input: Record<string, unknown> }; then?: Record<string, ScriptStep[]> }

export type ScriptTurn = {
  /** The user message that plays this turn, matched exactly after trimming. */
  prompt: string
  /**
   * Plays only when an earlier user message in the same session contains this
   * text, so a replay can show that a resumed or forked session kept its history.
   * A turn with a context wins over one with the same prompt and none.
   */
  context?: string
  steps: ScriptStep[]
}

export type ProviderScript = {
  /** The provider this script replaces, and whose format its `raw` steps use. */
  provider: ProviderId
  description: string
  recordedAt?: string
  turns: ScriptTurn[]
}

/** Maps one conversation's raw messages to events, as the live adapter does. */
type RawMapper = { push(raw: unknown): void; flush(): void; dispose(): void }

const RAW_MAPPERS: Partial<Record<ProviderId, (emit: (event: AgentEvent) => void) => RawMapper>> = {
  claude: (emit) => {
    const mapper = new ClaudeEventMapper(emit)
    return {
      push: (raw) => mapper.push(raw as ClaudeRawMessage),
      flush: () => mapper.flush(),
      dispose: () => mapper.dispose(),
    }
  },
}

function readScripts(folder: string) {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, script: JSON.parse(readFileSync(join(folder, file), 'utf8')) as ProviderScript }))
}

/** Whether the folder has a script for this provider, so the replay should replace it. */
export function hasScripts(folder: string, provider: ProviderId) {
  return readScripts(folder).some(({ script }) => script.provider === provider)
}

/**
 * The provider's turn for this message given the session's earlier messages.
 * Two scripts may not record the same prompt with the same context.
 */
function findTurn(folder: string, provider: ProviderId, text: string, history: readonly string[]) {
  const prompt = text.trim()
  const seen = new Map<string, string>()
  let plain: ScriptTurn | undefined
  let withContext: ScriptTurn | undefined
  for (const { file, script } of readScripts(folder)) {
    if (script.provider !== provider) continue
    for (const turn of script.turns) {
      if (turn.prompt.trim() !== prompt) continue
      const key = turn.context ?? ''
      const existing = seen.get(key)
      if (existing) throw new Error(`${existing} and ${file} both have a turn for: ${prompt}`)
      seen.set(key, file)
      if (!turn.context) plain = turn
      else if (history.some((earlier) => earlier.includes(turn.context!))) withContext = turn
    }
  }
  return withContext ?? plain
}

// The user messages of each scripted session by session id, so resuming or
// forking one carries its history like a real provider. On globalThis for the
// same reason as the runner's registry, and saved under the system temp folder
// so a session survives a server restart the way a provider's own session
// files do (the restart journeys resume through it).
const HISTORIES_KEY = Symbol.for('busyboy.scripted-histories')
const globalStore = globalThis as typeof globalThis & { [HISTORIES_KEY]?: Map<string, string[]> }
const histories = (globalStore[HISTORIES_KEY] ??= new Map())
const HISTORY_FOLDER = join(tmpdir(), 'busyboy-scripted-sessions')

/** Where a scripted session's history is saved; null for an id that is not a plain scripted one. */
export function scriptedHistoryFile(sessionId: string) {
  return /^scripted-[0-9a-f-]+$/.test(sessionId) ? join(HISTORY_FOLDER, `${sessionId}.json`) : null
}

function loadHistory(sessionId: string): string[] {
  const cached = histories.get(sessionId)
  if (cached) return cached
  const file = scriptedHistoryFile(sessionId)
  let history: string[] = []
  try {
    if (file) history = JSON.parse(readFileSync(file, 'utf8')) as string[]
  } catch {
    // Never saved: a new session.
  }
  histories.set(sessionId, history)
  return history
}

function saveHistory(sessionId: string, history: string[]) {
  const file = scriptedHistoryFile(sessionId)
  if (!file || histories.get(sessionId) !== history) return
  mkdirSync(HISTORY_FOLDER, { recursive: true })
  writeFileSync(file, JSON.stringify(history))
}

/** Continues, branches, or starts a session's history, and returns its session id. */
function openHistory({ resumeSessionId, forkSessionId }: ProviderStartOptions) {
  if (resumeSessionId) return { sessionId: resumeSessionId, history: loadHistory(resumeSessionId) }
  // A branch copies the original's history and, like a real fork that is not
  // kept, is never stored, so nothing reaches the original.
  if (forkSessionId) return { sessionId: `scripted-${randomUUID()}`, history: [...loadHistory(forkSessionId)] }
  const sessionId = `scripted-${randomUUID()}`
  const history: string[] = []
  histories.set(sessionId, history)
  return { sessionId, history }
}

function answerKey(answer: AgentAnswer) {
  if (answer.kind === 'approval') return answer.allow ? 'allow' : 'deny'
  return Object.values(answer.answers)[0] ?? ''
}

class Cancelled extends Error {}

type McpCall = { url: string; headers?: Record<string, string>; tool: string; input: Record<string, unknown> }

/** The calls to the session's HTTP MCP servers in a recorded Claude assistant message. */
function mcpCalls(message: ClaudeRawMessage, servers: Record<string, McpServer> = {}): McpCall[] {
  if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) return []
  return (message.message.content as { type?: string; name?: string; input?: Record<string, unknown> }[]).flatMap(
    (block) => {
      const match = block.type === 'tool_use' && block.name ? /^mcp__(.+?)__(.+)$/.exec(block.name) : null
      const server = match ? servers[match[1]] : undefined
      if (!match || !server || server.type === 'stdio') return []
      return [{ url: server.url, headers: server.headers, tool: match[2], input: block.input ?? {} }]
    },
  )
}

/** Calls one tool with a plain JSON-RPC `tools/call` request and returns its text. */
async function callMcpTool({ url, headers, tool, input }: McpCall) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: tool, arguments: input } }),
  })
  const body = (await response.json().catch(() => null)) as {
    result?: { isError?: boolean; content?: { text?: string }[] }
    error?: { message?: string }
  } | null
  const text = body?.result?.content?.map((part) => part.text ?? '').join('\n') ?? ''
  if (!response.ok || body?.error || body?.result?.isError) {
    throw new Error(`The ${tool} tool failed: ${body?.error?.message ?? (text || response.statusText)}`)
  }
  return text
}

function startScripted(folder: string, options: ProviderStartOptions): ProviderSession {
  const { provider } = options
  const lost = [options.resumeSessionId, options.forkSessionId].find((id) => id?.startsWith(MISSING_SESSION_PREFIX))
  const { sessionId, history } = lost ? { sessionId: lost, history: [] } : openHistory(options)
  let turnDone = false
  const emit = (event: AgentEvent) => {
    // Like a real provider, nothing follows `stopped`, even when a listener stops the
    // session in the middle of a step and the script has steps left.
    if (stopped && event.type !== 'stopped') return
    if (event.type === 'turn-done') turnDone = true
    options.emit(event)
  }
  // The scripted session reports its own session id, so a recorded one is dropped.
  const mapper = RAW_MAPPERS[provider]?.((event) => {
    if (event.type !== 'session') emit(event)
  })
  const queue: string[] = []
  const answers = new Map<string, (answer: AgentAnswer) => void>()
  let cancelTurn: (() => void) | undefined
  let running = false
  let inTurn = false
  let stopped = false
  let requestCount = 0

  const cancellable = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      cancelTurn = () => reject(new Cancelled())
      promise.then(resolve, reject)
    })

  const pause = async (event: Extract<AgentEvent, { type: 'approval' | 'question' }>) => {
    const answer = new Promise<AgentAnswer>((resolve) => answers.set(event.requestId, resolve))
    emit(event)
    try {
      return await cancellable(answer)
    } finally {
      answers.delete(event.requestId)
    }
  }

  const playSteps = async (steps: ScriptStep[]): Promise<void> => {
    for (const step of steps) {
      await cancellable(new Promise((resolve) => setTimeout(resolve, 'delayMs' in step ? step.delayMs : 0)))
      if ('delayMs' in step) continue
      if ('raw' in step) {
        if (!mapper) throw new Error(`Scripts cannot replay raw ${provider} messages yet.`)
        mapper.push(step.raw)
        if (provider === 'claude') {
          for (const call of mcpCalls(step.raw as ClaudeRawMessage, options.mcpServers)) {
            mapper.flush()
            try {
              await cancellable(callMcpTool(call))
            } catch (error) {
              if (error instanceof Cancelled) throw error
              emit({ type: 'error', code: 'provider', message: error instanceof Error ? error.message : String(error) })
            }
          }
        }
        continue
      }
      mapper?.flush()
      if ('writeInstructions' in step) {
        await cancellable(writeFile(join(options.cwd, step.writeInstructions), options.instructions ?? ''))
        continue
      }
      if ('toolCall' in step) {
        const { name, input } = step.toolCall
        const rule = matchAlwaysAsk({ rules: options.alwaysAsk ?? [], toolName: name, input, folder: options.cwd, privateFolder: options.privateFolder })
        const key = rule
          ? answerKey(await pause(alwaysAskApproval({ requestId: `script-${++requestCount}`, toolName: name, input, rule })))
          : 'allow'
        const branch = step.then?.[key]
        if (branch) return playSteps(branch)
        continue
      }
      if ('writeFile' in step) {
        const file = join(options.cwd, step.writeFile.path.replaceAll('<cwd-name>', basename(options.cwd)))
        await cancellable(mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, step.writeFile.text)))
        continue
      }
      if ('echoInstructions' in step) {
        emit({ type: 'text', itemId: `script-instructions-${++requestCount}`, text: options.instructions ?? '' })
        continue
      }
      let events: AgentEvent[]
      let then: Record<string, ScriptStep[]> | undefined
      if ('canUseTool' in step) {
        if (provider !== 'claude') throw new Error('Only Claude scripts can use `canUseTool` steps.')
        events = [claudePermissionToEvent(`script-${++requestCount}`, step.canUseTool)]
        then = step.then
      } else {
        events = [step.event]
        then = step.then
      }
      for (const event of events) {
        if (event.type === 'approval' || event.type === 'question') {
          // Pause first: `then?.[await pause()]` would skip the pause when there is no `then`.
          const key = answerKey(await pause(event))
          const branch = then?.[key]
          if (branch) return playSteps(branch)
        } else emit(event)
      }
    }
  }

  const drain = async () => {
    if (running) return
    running = true
    while (queue.length && !stopped) {
      const text = queue.shift()!
      inTurn = true
      turnDone = false
      try {
        const turn = findTurn(folder, provider, text, history)
        history.push(text)
        saveHistory(sessionId, history)
        if (!turn) {
          emit({ type: 'error', code: 'no-script', message: `No ${provider} script has a turn for: ${text}` })
        } else {
          await playSteps(turn.steps)
        }
        mapper?.flush()
        // Recorded turns end with the provider's own turn-done; hand-written ones may not.
        if (!turnDone) emit({ type: 'turn-done' })
      } catch (error) {
        mapper?.flush()
        if (stopped) {
          // Ended by stop(), which already reported it.
        } else if (error instanceof Cancelled) {
          emit({ type: 'turn-done' })
        } else {
          // A broken script must end the turn with an error, not hang the agent.
          emit({ type: 'error', code: 'no-script', message: error instanceof Error ? error.message : String(error) })
          emit({ type: 'turn-done' })
        }
      }
      inTurn = false
      cancelTurn = undefined
    }
    running = false
  }

  if (lost) {
    // Resuming fails the way it does for a session the provider no longer has.
    queueMicrotask(() => {
      if (stopped) return
      emit({ type: 'error', code: 'provider', message: `No conversation found with session ID: ${lost}` })
      // A listener may have stopped the session on the error already.
      if (stopped) return
      stopped = true
      emit({ type: 'stopped', finished: false })
    })
  } else queueMicrotask(() => emit({ type: 'session', sessionId }))

  return {
    send(text) {
      queue.push(text)
      void drain()
    },
    async interrupt() {
      cancelTurn?.()
    },
    async compact() {
      // The history is kept: unlike a real provider's summary, it still holds
      // every earlier message, so `context` turns keep matching after a compaction.
      emit({ type: 'turn-done' })
    },
    answer(requestId, answer) {
      answers.get(requestId)?.(answer)
    },
    async stop() {
      if (stopped) return
      stopped = true
      const finished = !inTurn
      cancelTurn?.()
      mapper?.dispose()
      emit({ type: 'stopped', finished })
    },
  }
}

export function createScriptedAdapter(folder: string): ProviderAdapter {
  return {
    start: (options) => startScripted(folder, options),
    signInStatus: async () => ({ state: 'signed-in', account: 'scripted' }),
  }
}
