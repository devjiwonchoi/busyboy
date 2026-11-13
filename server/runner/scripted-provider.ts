// Replays recorded provider runs with no model call. Selected for every
// provider when BUSYBOY_PROVIDER_SCRIPTS points at a folder of `*.json`
// scripts (tests do this). See `ProviderScript` for the format.
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claudeMessageToEvents,
  claudePermissionToEvent,
  type ClaudePermissionRequest,
  type ClaudeRawMessage,
} from './claude-events'
import type { AgentAnswer, AgentEvent, McpServerInput, ProviderAdapter, ProviderSession, ProviderStartOptions } from './contract'

export const SCRIPTS_ENV = 'BUSYBOY_PROVIDER_SCRIPTS'

/**
 * One step of a scripted turn.
 * - `event`: a normalized contract event, emitted as is.
 * - `raw`: a message in the script provider's own format, mapped by that provider's mapping.
 *   A Claude `tool_use` block named `mcp__<server>__<tool>`, where `<server>` is one of the
 *   session's `mcpServers`, really calls that tool, so a replay runs busyboy's own tool code.
 * - `canUseTool`: a recorded Claude permission request, mapped to an approval or question.
 * - `delayMs`: wait before the next step.
 * An approval or question (from `event` or `canUseTool`) pauses the replay until it is
 * answered. With `then`, the branch named by the answer replaces the rest of the turn:
 * `allow` or `deny` for an approval, the chosen label of the first question for a question.
 */
export type ScriptStep =
  | { event: AgentEvent; then?: Record<string, ScriptStep[]> }
  | { raw: ClaudeRawMessage }
  | { canUseTool: ClaudePermissionRequest; then?: Record<string, ScriptStep[]> }
  | { delayMs: number }

export type ScriptTurn = {
  /** The user message that plays this turn, matched exactly after trimming. */
  prompt: string
  steps: ScriptStep[]
}

export type ProviderScript = {
  /** Whose format the `raw` and `canUseTool` steps use. */
  provider: 'claude'
  description: string
  recordedAt?: string
  turns: ScriptTurn[]
}

function loadTurns(folder: string) {
  const turns = new Map<string, ScriptTurn>()
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.json')).sort()) {
    const script = JSON.parse(readFileSync(join(folder, file), 'utf8')) as ProviderScript
    for (const turn of script.turns) turns.set(turn.prompt.trim(), turn)
  }
  return turns
}

function answerKey(answer: AgentAnswer) {
  if (answer.kind === 'approval') return answer.allow ? 'allow' : 'deny'
  return Object.values(answer.answers)[0] ?? ''
}

class Cancelled extends Error {}

type McpCall = { server: McpServerInput; tool: string; input: Record<string, unknown> }

/** The busyboy MCP tool calls in a recorded Claude assistant message. */
function mcpCalls(message: ClaudeRawMessage, servers: McpServerInput[] = []): McpCall[] {
  if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) return []
  return (message.message.content as { type?: string; name?: string; input?: Record<string, unknown> }[]).flatMap(
    (block) => {
      const match = block.type === 'tool_use' && block.name ? /^mcp__(.+?)__(.+)$/.exec(block.name) : null
      const server = match && servers.find(({ name }) => name === match[1])
      return server ? [{ server, tool: match[2], input: block.input ?? {} }] : []
    },
  )
}

/** Calls one tool with a plain JSON-RPC `tools/call` request and returns its text. */
async function callMcpTool({ server, tool, input }: McpCall) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...server.headers },
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
  const { emit } = options
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
      let events: AgentEvent[]
      let then: Record<string, ScriptStep[]> | undefined
      if ('raw' in step) events = claudeMessageToEvents(step.raw)
      else if ('canUseTool' in step) {
        events = [claudePermissionToEvent(`script-${++requestCount}`, step.canUseTool)]
        then = step.then
      } else {
        events = [step.event]
        then = step.then
      }
      for (const event of events) {
        if (event.type === 'session') continue
        if (event.type === 'approval' || event.type === 'question') {
          // Pause first: `then?.[await pause()]` would skip the pause when there is no `then`.
          const key = answerKey(await pause(event))
          const branch = then?.[key]
          if (branch) return playSteps(branch)
        } else emit(event)
      }
      if ('raw' in step) {
        for (const call of mcpCalls(step.raw, options.mcpServers)) {
          try {
            await cancellable(callMcpTool(call))
          } catch (error) {
            if (error instanceof Cancelled) throw error
            emit({ type: 'error', code: 'provider', message: error instanceof Error ? error.message : String(error) })
          }
        }
      }
    }
  }

  const drain = async () => {
    if (running) return
    running = true
    while (queue.length && !stopped) {
      const text = queue.shift()!
      inTurn = true
      const turn = loadTurns(folder).get(text.trim())
      try {
        if (!turn) {
          emit({ type: 'error', code: 'no-script', message: `No provider script has a turn for: ${text}` })
          emit({ type: 'turn-done' })
        } else {
          await playSteps(turn.steps)
          // Recorded turns end with a result message; hand-written ones may not.
          if (inTurn && !turn.steps.some((step) => 'raw' in step && step.raw.type === 'result')) emit({ type: 'turn-done' })
        }
      } catch (error) {
        if (!(error instanceof Cancelled)) throw error
        if (!stopped) emit({ type: 'turn-done' })
      }
      inTurn = false
      cancelTurn = undefined
    }
    running = false
  }

  queueMicrotask(() => emit({ type: 'session', sessionId: options.resumeSessionId ?? `scripted-${randomUUID()}` }))

  return {
    send(text) {
      queue.push(text)
      void drain()
    },
    async interrupt() {
      cancelTurn?.()
    },
    async compact() {
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
