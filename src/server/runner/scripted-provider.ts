// Replays recorded provider runs with no model call. When
// BUSYBOY_PROVIDER_SCRIPTS points at a folder of `*.json` scripts (tests do
// this), it replaces each provider that has at least one script there; other
// providers keep their real adapter (for example one pointed at a fake CLI).
// See `ProviderScript` for the format.
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
// same reason as the runner's registry.
const HISTORIES_KEY = Symbol.for('busyboy.scripted-histories')
const globalStore = globalThis as typeof globalThis & { [HISTORIES_KEY]?: Map<string, string[]> }
const histories = (globalStore[HISTORIES_KEY] ??= new Map())

/** Continues, branches, or starts a session's history, and returns its session id. */
function openHistory({ resumeSessionId, forkSessionId }: ProviderStartOptions) {
  if (resumeSessionId) {
    const history = histories.get(resumeSessionId) ?? []
    histories.set(resumeSessionId, history)
    return { sessionId: resumeSessionId, history }
  }
  // A branch copies the original's history and, like a real fork that is not
  // kept, is never stored, so nothing reaches the original.
  if (forkSessionId) return { sessionId: `scripted-${randomUUID()}`, history: [...(histories.get(forkSessionId) ?? [])] }
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
      stopped = true
      emit({ type: 'error', code: 'provider', message: `No conversation found with session ID: ${lost}` })
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
