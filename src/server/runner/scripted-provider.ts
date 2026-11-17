import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { containsPath } from '../paths'
import { alwaysAskApproval, createAllowedCalls, matchAlwaysAsk } from './always-ask'
import { checkUserRules, userRuleApproval } from './user-rules'
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
import { harnessReceipt, type UserTurn } from './user-turn'

export const SCRIPTS_ENV = 'BUSYBOY_PROVIDER_SCRIPTS'

export const MISSING_SESSION_PREFIX = 'missing-'

// A Claude tool_use named mcp__<server>__<tool> really calls that tool, so a replay runs BusyBoy's own tool code.
export type ScriptStep =
  | { event: AgentEvent; then?: Record<string, ScriptStep[]> }
  | { raw: unknown }
  | { canUseTool: ClaudePermissionRequest; then?: Record<string, ScriptStep[]> }
  | { delayMs: number }
  | { echoInstructions: true }
  | { echoAttachments: true }
  | { writeInstructions: string }
  | { writeFile: { path: string; text: string } }
  | { toolCall: { name: string; input: Record<string, unknown> }; then?: Record<string, ScriptStep[]> }
  | { repeat: { count: number; event: AgentEvent } }

export type ScriptTurn = {
  prompt: string
  context?: string
  steps: ScriptStep[]
}

export type ProviderScript = {
  provider: ProviderId
  description: string
  recordedAt?: string
  turns: ScriptTurn[]
}

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

export function hasScripts(folder: string, provider: ProviderId) {
  return readScripts(folder).some(({ script }) => script.provider === provider)
}

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

// Saved under the system temp folder so a session survives a restart the way a provider's own session files do.
const HISTORIES_KEY = Symbol.for('busyboy.scripted-histories')
const globalStore = globalThis as typeof globalThis & { [HISTORIES_KEY]?: Map<string, string[]> }
const histories = (globalStore[HISTORIES_KEY] ??= new Map())
const HISTORY_FOLDER = join(tmpdir(), 'busyboy-scripted-sessions')

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
  // Writing in place empties the file first, and a reader in that gap fails to parse the history.
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(history))
  renameSync(temporary, file)
}

function openHistory({ resumeSessionId, forkSessionId }: ProviderStartOptions) {
  if (resumeSessionId) return { sessionId: resumeSessionId, history: loadHistory(resumeSessionId) }
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
    if (stopped && event.type !== 'stopped') return
    if (event.type === 'turn-done') turnDone = true
    options.emit(event)
  }
  const mapper = RAW_MAPPERS[provider]?.((event) => {
    if (event.type !== 'session') emit(event)
  })
  const queue: UserTurn[] = []
  let received: UserTurn = { text: '', note: '', images: [] }
  const answers = new Map<string, (answer: AgentAnswer) => void>()
  let cancelTurn: (() => void) | undefined
  let running = false
  let inTurn = false
  let stopped = false
  let requestCount = 0
  const allowedCalls = createAllowedCalls()

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
      if ('repeat' in step) {
        const { count, event } = step.repeat
        if (!Number.isInteger(count) || count < 1 || count > 20_000) {
          throw new Error(`A repeat step needs a count from 1 to 20000, not ${String(count)}.`)
        }
        const template = JSON.stringify(event)
        for (let index = 0; index < count; index += 1) {
          emit(JSON.parse(template.replaceAll('{{n}}', String(index))) as AgentEvent)
          if (index % 500 === 499) await cancellable(new Promise((resolve) => setImmediate(resolve)))
        }
        continue
      }
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
        const { name } = step.toolCall
        // `<cwd>` and `<record-folder>` stand in for this task's paths, so a script can name them.
        const input = fillTaskPaths(step.toolCall.input, options.cwd, options.recordFolder)
        let key = 'allow'
        const userRule = await checkUserRules({ rulesFolder: options.rulesFolder, toolName: name, input, cwd: options.cwd, recordFolder: options.recordFolder })
        if (userRule.ask) {
          const remembered = { toolName: name, input, rule: userRule.ruleKey, cwd: options.cwd }
          if (!(userRule.remember && allowedCalls.has(remembered))) {
            const answer = await pause(userRuleApproval({ requestId: `script-${++requestCount}`, toolName: name, input, detail: userRule.detail, remember: userRule.remember }))
            if (answer.kind === 'approval' && answer.allow && answer.forSession && userRule.remember) allowedCalls.add(remembered)
            if (!(answer.kind === 'approval' && answer.allow)) {
              const branch = step.then?.deny
              if (branch) return playSteps(branch)
              continue
            }
          }
        }
        const rule = matchAlwaysAsk({ rules: options.alwaysAsk ?? [], toolName: name, input, folder: options.cwd, recordFolder: options.recordFolder, privateFolder: options.privateFolder, noFileEdits: options.noFileEdits })
        const call = { toolName: name, input, rule: rule ?? '', cwd: options.cwd }
        if (rule && !allowedCalls.has(call)) {
          const answer = await pause(alwaysAskApproval({ requestId: `script-${++requestCount}`, toolName: name, input, rule }))
          if (answer.kind === 'approval' && answer.allow && answer.forSession) allowedCalls.add(call)
          key = answerKey(answer)
        }
        const branch = step.then?.[key]
        if (branch) return playSteps(branch)
        continue
      }
      if ('writeFile' in step) {
        const relative = step.writeFile.path.replaceAll('<cwd-name>', basename(options.cwd))
        const recordFile = scriptedRecordFile(options.recordFolder, relative)
        if (relative.replaceAll('\\', '/').startsWith('.jwn/') && !recordFile) {
          throw new Error('This task has no record folder, so the record was not written.')
        }
        const file = recordFile ?? join(options.cwd, relative)
        await cancellable(mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, step.writeFile.text)))
        continue
      }
      if ('echoInstructions' in step) {
        emit({ type: 'text', itemId: `script-instructions-${++requestCount}`, text: options.instructions ?? '' })
        continue
      }
      if ('echoAttachments' in step) {
        emit({ type: 'text', itemId: `script-attachments-${++requestCount}`, text: harnessReceipt(received) || 'no attachments' })
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
      const message = queue.shift()!
      received = message
      const text = message.text.trim()
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
        if (!turnDone) emit({ type: 'turn-done' })
      } catch (error) {
        mapper?.flush()
        if (stopped) {
          // Ended by stop(), which already reported it.
        } else if (error instanceof Cancelled) {
          emit({ type: 'turn-done' })
        } else {
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
    queueMicrotask(() => {
      if (stopped) return
      emit({ type: 'error', code: 'provider', message: `No conversation found with session ID: ${lost}` })
      if (stopped) return
      stopped = true
      emit({ type: 'stopped', finished: false })
    })
  } else queueMicrotask(() => emit({ type: 'session', sessionId }))

  return {
    send(turn) {
      queue.push(turn)
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
      mapper?.dispose()
      emit({ type: 'stopped', finished })
    },
  }
}

function fillTaskPaths(input: Record<string, unknown>, cwd: string, recordFolder: string | undefined): Record<string, unknown> {
  const fill = (value: string) => value.replaceAll('<cwd>', cwd).replaceAll('<record-folder>', recordFolder ?? '<record-folder>')
  const next: Record<string, unknown> = { ...input }
  for (const key of ['command', 'cmd', 'command_line', 'commandLine']) {
    const value = next[key]
    if (typeof value === 'string') next[key] = fill(value)
    else if (Array.isArray(value)) next[key] = value.map((part) => (typeof part === 'string' ? fill(part) : part))
  }
  return next
}

function scriptedRecordFile(recordFolder: string | undefined, relative: string): string | null {
  const normalized = relative.replaceAll('\\', '/')
  if (!recordFolder || !normalized.startsWith('.jwn/')) return null
  const parts = normalized.split('/').slice(2)
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) return null
  const file = join(/*turbopackIgnore: true*/ recordFolder, ...parts)
  return containsPath(recordFolder, file) ? file : null
}

export function createScriptedAdapter(folder: string): ProviderAdapter {
  return {
    start: (options) => startScripted(folder, options),
    signInStatus: async () => ({ state: 'signed-in', account: 'scripted' }),
  }
}
