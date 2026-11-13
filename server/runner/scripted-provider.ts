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
import { codexMessageToEvents, codexRequestToEvent, type CodexRawMessage } from './codex-events'
import type { AgentAnswer, AgentEvent, ProviderAdapter, ProviderId, ProviderSession, ProviderStartOptions } from './contract'

export const SCRIPTS_ENV = 'BUSYBOY_PROVIDER_SCRIPTS'

/**
 * One step of a scripted turn.
 * - `event`: a normalized contract event, emitted as is.
 * - `raw`: a message in the script provider's own format, mapped by that provider's mapping:
 *   a Claude SDK message, or a Codex app-server notification or server request (with `id`).
 * - `canUseTool`: a recorded Claude permission request, mapped to an approval or question.
 * - `delayMs`: wait before the next step.
 * An approval or question (from `event`, `canUseTool`, or a Codex server request) pauses the replay until it is
 * answered. With `then`, the branch named by the answer replaces the rest of the turn:
 * `allow` or `deny` for an approval, the chosen label of the first question for a question.
 */
export type ScriptStep =
  | { event: AgentEvent; then?: Record<string, ScriptStep[]> }
  | { raw: ClaudeRawMessage | CodexRawMessage; then?: Record<string, ScriptStep[]> }
  | { canUseTool: ClaudePermissionRequest; then?: Record<string, ScriptStep[]> }
  | { delayMs: number }

export type ScriptTurn = {
  /** The user message that plays this turn, matched exactly after trimming. */
  prompt: string
  steps: ScriptStep[]
}

export type ProviderScript = {
  /** Whose format the `raw` and `canUseTool` steps use. Only agents of this provider play the script. */
  provider: ProviderId
  description: string
  recordedAt?: string
  turns: ScriptTurn[]
}

function loadTurns(folder: string, provider: ProviderId) {
  const turns = new Map<string, ScriptTurn>()
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.json')).sort()) {
    const script = JSON.parse(readFileSync(join(folder, file), 'utf8')) as ProviderScript
    if (script.provider !== provider) continue
    for (const turn of script.turns) turns.set(turn.prompt.trim(), turn)
  }
  return turns
}

function answerKey(answer: AgentAnswer) {
  if (answer.kind === 'approval') return answer.allow ? 'allow' : 'deny'
  return Object.values(answer.answers)[0] ?? ''
}

function isTurnEnd(raw: ClaudeRawMessage | CodexRawMessage) {
  return ('type' in raw && raw.type === 'result') || ('method' in raw && raw.method === 'turn/completed')
}

class Cancelled extends Error {}

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

  const rawToEvents = (raw: ClaudeRawMessage | CodexRawMessage): AgentEvent[] => {
    if (options.provider === 'claude') return claudeMessageToEvents(raw as ClaudeRawMessage)
    const message = raw as CodexRawMessage
    if (message.id === undefined) return codexMessageToEvents(message)
    const request = codexRequestToEvent(`script-${++requestCount}`, message)
    return request ? [request] : []
  }

  const playSteps = async (steps: ScriptStep[]): Promise<void> => {
    for (const step of steps) {
      await cancellable(new Promise((resolve) => setTimeout(resolve, 'delayMs' in step ? step.delayMs : 0)))
      if ('delayMs' in step) continue
      let events: AgentEvent[]
      let then: Record<string, ScriptStep[]> | undefined
      if ('raw' in step) {
        events = rawToEvents(step.raw)
        then = step.then
      } else if ('canUseTool' in step) {
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
    }
  }

  const drain = async () => {
    if (running) return
    running = true
    while (queue.length && !stopped) {
      const text = queue.shift()!
      inTurn = true
      const turn = loadTurns(folder, options.provider).get(text.trim())
      try {
        if (!turn) {
          emit({ type: 'error', code: 'no-script', message: `No provider script has a turn for: ${text}` })
          emit({ type: 'turn-done' })
        } else {
          await playSteps(turn.steps)
          // Recorded turns end with a result message; hand-written ones may not.
          if (inTurn && !turn.steps.some((step) => 'raw' in step && isTurnEnd(step.raw))) emit({ type: 'turn-done' })
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
