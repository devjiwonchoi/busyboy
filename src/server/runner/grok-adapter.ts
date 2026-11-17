import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { alwaysAskApproval, createAllowedCalls, matchAlwaysAsk } from './always-ask'
import { checkUserRules, userRuleApproval, userRulesHookNeeded } from './user-rules'
import { spawnClaudeProcess as spawnProcessGroup, type ClaudeProcess as GroupProcess } from './claude-process'
import type {
  AgentAnswer,
  AgentEvent,
  McpServer,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  Question,
  SignInStatus,
} from './contract'
import { agentEnvironment, findExecutable } from './find-executable'
import { modelText, type UserTurn } from './user-turn'
import {
  GrokEventMapper,
  grokCanAllowForSession,
  grokPermissionOutcome,
  grokStopMessage,
  grokToolSubject,
  grokTrustedTool,
  type GrokPermissionOption,
} from './grok-events'

// Grok's hooks are fail-open, so always-ask is decided on session/request_permission instead.
export const GROK_PATH_ENV = 'BUSYBOY_GROK_PATH'
const SIGN_IN_TIMEOUT_MS = 20_000
const CLOSE_WAIT_MS = 500
const CLIENT_INFO = { name: 'busyboy', title: 'BusyBoy', version: '0.0.0' }

function resolveGrok() {
  return process.env[GROK_PATH_ENV] || findExecutable('grok')
}

// default asks BusyBoy for every tool. auto is Grok's own auto mode, used only when nothing on our side has to see every call.
export function grokPermissionMode(options: ProviderStartOptions, enforce: boolean) {
  if (options.noTools) return 'dontAsk'
  if (enforce) return 'default'
  return options.permissionMode === 'full-access' ? 'bypassPermissions' : 'auto'
}

export function grokMcpServers(servers: Record<string, McpServer> = {}, capabilities?: { http?: boolean; sse?: boolean }) {
  const mcpServers: unknown[] = []
  const skipped: string[] = []
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'stdio') {
      mcpServers.push({
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
      })
    } else if (server.type === 'http' && capabilities?.http === false) {
      skipped.push(`Grok cannot use the MCP server ${name}: this Grok does not connect to HTTP servers.`)
    } else if (server.type === 'sse' && capabilities?.sse === false) {
      skipped.push(`Grok cannot use the MCP server ${name}: this Grok does not connect to SSE servers.`)
    } else {
      mcpServers.push({
        type: server.type,
        name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
      })
    }
  }
  return { mcpServers, skipped }
}

type RpcMessage = {
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

type InitResult = {
  authMethods?: { id?: string }[]
  agentCapabilities?: {
    loadSession?: boolean
    mcpCapabilities?: { http?: boolean; sse?: boolean }
    promptCapabilities?: { image?: boolean }
  }
}

class GrokExited extends Error {
  constructor() {
    super('The Grok agent exited.')
  }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

class AcpConnection {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  readonly exited: Promise<{ code: number | null; stderr: string }>

  constructor(
    private child: GroupProcess,
    onMessage: (message: RpcMessage) => void,
  ) {
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      let message: RpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method) {
        onMessage(message)
        return
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (!pending) return
        if (message.error) pending.reject(new Error(message.error.message ?? 'Grok request failed.'))
        else pending.resolve(message.result)
      }
    })
    this.exited = new Promise((resolve) => {
      let spawnError = ''
      const process = child as unknown as ChildProcess
      process.on('error', (error) => {
        spawnError = error.message
      })
      const done = (code: number | null) => {
        if (this.closed) return
        this.closed = true
        for (const [, pending] of this.pending) pending.reject(new GrokExited())
        this.pending.clear()
        resolve({ code, stderr: [child.stderrTail(), spawnError].filter(Boolean).join('\n') })
      }
      process.on('close', done)
      process.on('exit', (code) => setTimeout(() => done(code), CLOSE_WAIT_MS).unref())
    })
  }

  private write(message: object) {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new GrokExited())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  respond(id: string | number, result: unknown) {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: string | number, message: string) {
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } })
  }

  initialize() {
    return this.request<InitResult>('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT_INFO,
      // Advertising file tools makes Grok run writes through the client instead of session/request_permission.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
  }

  async kill() {
    await this.child.stop()
    this.child.stdin.end()
  }
}

function spawnGrok(executable: string, args: string[], cwd: string, onMessage: (message: RpcMessage) => void) {
  const env = agentEnvironment() as NodeJS.ProcessEnv
  const script = /\.[cm]?js$/i.test(executable)
  const command = script ? (findExecutable('node') ?? 'node') : executable
  const commandArgs = script ? [executable, ...args] : args
  const child = spawnProcessGroup({ command, args: commandArgs, cwd, env, signal: new AbortController().signal })
  return new AcpConnection(child, onMessage)
}

// Permission mode belongs before agent. There is no ACP instruction field Grok honors for the system prompt.
function launchArgs(mode: string) {
  return ['--no-auto-update', '--permission-mode', mode, 'agent', '--no-leader', 'stdio']
}

function promptBlocks(turn: UserTurn, allowImages: boolean) {
  const paths = allowImages ? '' : turn.images.map((image) => image.path).filter(Boolean).join('\n')
  const text = [modelText(turn), paths].filter(Boolean).join('\n\n') || ' '
  return [
    ...(allowImages ? turn.images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mediaType })) : []),
    { type: 'text' as const, text },
  ]
}

function rulesMeta(instructions?: string) {
  const rules = instructions?.trim()
  return rules ? { _meta: { rules } } : {}
}

function authMethod(methods: { id?: string }[] | undefined) {
  const ids = new Set((methods ?? []).map((method) => method.id).filter((id): id is string => Boolean(id)))
  if (process.env.XAI_API_KEY && ids.has('xai.api_key')) return 'xai.api_key'
  if (ids.has('cached_token')) return 'cached_token'
  if (ids.has('xai.api_key')) return 'xai.api_key'
  return undefined
}

async function authenticate(connection: AcpConnection, init: InitResult) {
  const methodId = authMethod(init.authMethods)
  if (methodId) {
    await connection.request('authenticate', { methodId, _meta: { headless: true } })
    return
  }
  if ((init.authMethods ?? []).length > 0) throw new Error('Grok is not signed in. Run `grok login`.')
}

const LOST_SESSION = /no conversation found with session id/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function permissionOptions(value: unknown): GrokPermissionOption[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is GrokPermissionOption => isRecord(entry) && typeof entry.optionId === 'string',
  )
}

function questionList(value: unknown): Question[] {
  if (!Array.isArray(value)) return []
  const questions: Question[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.question !== 'string') continue
    const options = Array.isArray(entry.options)
      ? entry.options.filter((option): option is { label: string; description?: string } => isRecord(option) && typeof option.label === 'string')
      : []
    questions.push({
      question: entry.question,
      header: typeof entry.header === 'string' ? entry.header : undefined,
      options: options.map((option) => ({ label: option.label, description: typeof option.description === 'string' ? option.description : undefined })),
      multiSelect: entry.multiSelect === true,
    })
  }
  return questions
}

function startGrok(options: ProviderStartOptions): ProviderSession {
  const { emit } = options
  const enforce =
    !options.noTools &&
    ((options.alwaysAsk?.length ?? 0) > 0 || Boolean(options.privateFolder) || Boolean(options.noFileEdits) || userRulesHookNeeded(options.rulesFolder))
  const mode = grokPermissionMode(options, enforce)
  const trusted = new Set(Object.entries(options.mcpServers ?? {}).filter(([, server]) => server.trusted).map(([name]) => name))
  const queue: UserTurn[] = []
  let allowImages = false
  const asks = new Map<string, (answer: AgentAnswer | null) => void>()
  const allowedCalls = createAllowedCalls()
  const mapper = new GrokEventMapper(emit)
  let connection: AcpConnection | undefined
  let sessionId: string | undefined
  let inTurn = false
  let accepting = false
  let stopRequested = false
  let failed = false
  let ready: Promise<void> | undefined
  let turnToken = 0

  const fail = (message: string, code: 'provider' | 'signed-out' | 'lost-session' = 'provider') => {
    if (failed || stopRequested) return
    failed = true
    emit({ type: 'error', code, message })
  }

  const finishTurn = (event: AgentEvent) => {
    accepting = false
    if (event.type === 'turn-done') {
      inTurn = false
      if (queue.length > 0) event = { ...event, more: true }
    }
    mapper.endTurn()
    emit(event)
    if (event.type === 'turn-done') startNextTurn()
  }

  const startNextTurn = () => {
    if (inTurn || !connection || !sessionId || stopRequested) return
    const turn = queue.shift()
    if (turn === undefined) return
    inTurn = true
    accepting = true
    mapper.beginTurn()
    const token = ++turnToken
    const current = connection
    current
      .request<{ stopReason?: string }>('session/prompt', { sessionId, prompt: promptBlocks(turn, allowImages) })
      .then((result) => {
        if (token !== turnToken || stopRequested) return
        const stop = result?.stopReason ?? 'end_turn'
        if (stop !== 'end_turn' && stop !== 'cancelled') emit({ type: 'error', code: 'provider', message: grokStopMessage(stop) })
        finishTurn({ type: 'turn-done' })
      })
      .catch((error: Error) => {
        if (token !== turnToken || stopRequested || error instanceof GrokExited) return
        emit({ type: 'error', code: 'provider', message: error.message })
        finishTurn({ type: 'turn-done' })
      })
  }

  const dropAsks = () => {
    for (const [requestId, resolve] of asks) {
      asks.delete(requestId)
      resolve(null)
      emit({ type: 'answered', requestId })
    }
  }

  const decide = async (rpcId: string | number, params: Record<string, unknown>) => {
    const current = connection
    if (!current) return
    const optionsList = permissionOptions(params.options)
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
    const respond = (decision: 'allow' | 'allow-session' | 'deny' | 'cancel') =>
      current.respond(rpcId, grokPermissionOutcome(optionsList, decision))
    if (options.noTools || stopRequested) {
      respond(options.noTools ? 'deny' : 'cancel')
      return
    }
    const subject = grokToolSubject(toolCall)
    // Grok's own hooks are fail-open, so user rules are decided on this permission request.
    const userRule = await checkUserRules({
      rulesFolder: options.rulesFolder,
      toolName: subject.toolName,
      input: subject.input,
      cwd: options.cwd,
      recordFolder: options.recordFolder,
    })
    if (userRule.ask) {
      const remembered = { toolName: subject.toolName, input: subject.input, rule: userRule.ruleKey, cwd: options.cwd }
      if (!(userRule.remember && allowedCalls.has(remembered))) {
        const requestId = `grok-rule-${rpcId}`
        const answer = await waitFor(
          requestId,
          userRuleApproval({ requestId, toolName: subject.toolName, input: subject.input, detail: userRule.detail, remember: userRule.remember }),
        )
        if (!answer || answer.kind !== 'approval' || !answer.allow) {
          respond('deny')
          return
        }
        if (answer.forSession && userRule.remember) allowedCalls.add(remembered)
      }
    }
    const rule = matchAlwaysAsk({
      rules: options.alwaysAsk ?? [],
      toolName: subject.toolName,
      input: subject.input,
      folder: options.cwd,
      recordFolder: options.recordFolder,
      privateFolder: options.privateFolder,
      noFileEdits: options.noFileEdits,
    })
    const call = { toolName: subject.toolName, input: subject.input, rule: rule ?? '', cwd: options.cwd }
    const remembered = Boolean(rule) && allowedCalls.has(call)
    const runWithoutAsking =
      remembered || (!rule && (enforce || options.permissionMode === 'full-access' || grokTrustedTool(toolCall, trusted)))
    if (runWithoutAsking) {
      respond('allow')
      return
    }
    if (!rule) {
      const requestId = `grok-${rpcId}`
      const answer = await waitFor(requestId, {
        type: 'approval',
        requestId,
        title: subject.title,
        detail: typeof subject.input.command === 'string' ? subject.input.command : undefined,
        canAllowForSession: grokCanAllowForSession(optionsList),
      })
      if (!answer || answer.kind !== 'approval') {
        respond('cancel')
        return
      }
      respond(answer.allow ? (answer.forSession ? 'allow-session' : 'allow') : 'deny')
      return
    }
    const requestId = `grok-${rpcId}`
    const answer = await waitFor(requestId, alwaysAskApproval({ requestId, toolName: subject.toolName, input: subject.input, rule }))
    if (!answer || answer.kind !== 'approval') {
      respond('cancel')
      return
    }
    if (answer.allow) {
      if (answer.forSession) allowedCalls.add(call)
      respond(answer.forSession ? 'allow-session' : 'allow')
      return
    }
    respond('deny')
  }

  const waitFor = (requestId: string, event: AgentEvent) =>
    new Promise<AgentAnswer | null>((resolve) => {
      asks.set(requestId, resolve)
      mapper.flush()
      emit(event)
    })

  const onQuestion = async (rpcId: string | number, params: Record<string, unknown>) => {
    const current = connection
    if (!current) return
    const questions = questionList(params.questions)
    if (questions.length === 0 || stopRequested) {
      current.respond(rpcId, { outcome: 'skip_interview' })
      return
    }
    const requestId = `grok-ask-${rpcId}`
    const answer = await waitFor(requestId, { type: 'question', requestId, questions })
    if (!answer || answer.kind !== 'question') {
      current.respond(rpcId, { outcome: 'skip_interview' })
      return
    }
    const answers: Record<string, string | string[]> = {}
    for (const question of questions) {
      const value = answer.answers[question.question]
      if (value === undefined) continue
      answers[question.question] = question.multiSelect ? value.split(', ').filter(Boolean) : value
    }
    current.respond(rpcId, { outcome: 'accepted', answers })
  }

  const handle = async (message: RpcMessage) => {
    if (message.method === 'session/update') {
      if (!accepting) return
      const params = isRecord(message.params) ? message.params : {}
      const update = isRecord(params.update) ? params.update : params
      if (typeof update.sessionUpdate === 'string' || typeof update.session_update === 'string') mapper.pushUpdate(update)
      return
    }
    if (message.id === undefined || message.id === null || !message.method) return
    const params = isRecord(message.params) ? message.params : {}
    if (message.method === 'session/request_permission') {
      await decide(message.id, params)
      return
    }
    if (message.method === '_x.ai/ask_user_question') {
      await onQuestion(message.id, params)
      return
    }
    connection?.respondError(message.id, `BusyBoy does not handle ${message.method}.`)
  }

  const run = async () => {
    const executable = resolveGrok()
    if (!executable) {
      emit({ type: 'error', code: 'not-installed', message: 'The `grok` command was not found on PATH.' })
      return false
    }
    connection = spawnGrok(executable, launchArgs(mode), options.cwd, (message) => {
      handle(message).catch((error: unknown) => {
        if (message.id !== undefined && message.id !== null) {
          connection?.respondError(message.id, 'BusyBoy could not read that request.')
        }
        emit({
          type: 'error',
          code: 'provider',
          message: `BusyBoy could not read a Grok message: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
    })
    const current = connection
    if (stopRequested) void current.kill()
    ready = (async () => {
      const init = await current.initialize()
      allowImages = init.agentCapabilities?.promptCapabilities?.image === true
      await authenticate(current, init)
      const mcp = grokMcpServers(options.mcpServers, init.agentCapabilities?.mcpCapabilities)
      for (const notice of mcp.skipped) emit({ type: 'error', code: 'provider', message: notice })
      const body = { cwd: options.cwd, mcpServers: mcp.mcpServers, ...rulesMeta(options.instructions) }
      if (options.forkSessionId) {
        sessionId = await forkSession(current, options.forkSessionId, body)
      } else if (options.resumeSessionId) {
        await current.request('session/load', { sessionId: options.resumeSessionId, ...body })
        sessionId = options.resumeSessionId
      } else {
        const created = await current.request<{ sessionId?: string }>('session/new', body)
        sessionId = created.sessionId
      }
      if (!sessionId) throw new Error('Grok did not return a session id.')
      await current.request('session/set_mode', { sessionId, modeId: mode }).catch(() => {})
      emit({ type: 'session', sessionId })
      startNextTurn()
    })()
    ready.catch((error: Error) => {
      if (error instanceof GrokExited || stopRequested) return
      const resuming = Boolean(options.resumeSessionId || options.forkSessionId)
      if (resuming && LOST_SESSION.test(error.message)) fail(error.message, 'lost-session')
      else if (/not signed in|sign in|run `grok login`/i.test(error.message)) fail('Grok is not signed in. Run `grok login`.', 'signed-out')
      else fail(error.message)
      void current.kill()
    })
    const { code, stderr } = await current.exited
    dropAsks()
    mapper.flush()
    mapper.dispose()
    if (!failed && !stopRequested) fail(stderr.trim() || `The Grok agent exited with code ${code}.`)
    return stopRequested && !inTurn && queue.length === 0
  }

  run()
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error))
      return false
    })
    .then((finished) => emit({ type: 'stopped', finished }))

  return {
    send(turn) {
      queue.push(turn)
      startNextTurn()
    },
    async interrupt() {
      dropAsks()
      if (sessionId && inTurn) connection?.notify('session/cancel', { sessionId })
      else if (!sessionId && queue.length > 0) {
        queue.length = 0
        emit({ type: 'turn-done' })
      }
    },
    async compact() {
      await ready?.catch(() => {})
      if (!connection || !sessionId) return
      if (inTurn) throw new Error('Grok is running a turn. Compact once it ends.')
      inTurn = true
      try {
        await connection.request('_x.ai/compact_conversation', { sessionId })
        finishTurn({ type: 'turn-done' })
      } catch (error) {
        emit({ type: 'error', code: 'provider', message: error instanceof Error ? error.message : String(error) })
        finishTurn({ type: 'turn-done' })
      }
    },
    answer(requestId, answer) {
      const resolve = asks.get(requestId)
      if (!resolve) return
      asks.delete(requestId)
      resolve(answer)
    },
    async stop() {
      stopRequested = true
      turnToken += 1
      await connection?.kill()
    },
  }
}

async function forkSession(connection: AcpConnection, sessionId: string, body: object) {
  const params = { sessionId, ...body }
  try {
    const created = await connection.request<{ sessionId?: string }>('session/fork', params)
    if (!created.sessionId) throw new Error('Grok did not return a session id for the branch.')
    return created.sessionId
  } catch (error) {
    if (!(error instanceof Error) || !/method not found|-32601|does not handle session\/fork/i.test(error.message)) throw error
    const created = await connection.request<{ sessionId?: string }>('_x.ai/session/fork', params)
    if (!created.sessionId) throw new Error('Grok did not return a session id for the branch.')
    return created.sessionId
  }
}

async function grokSignInStatus(): Promise<SignInStatus> {
  const executable = resolveGrok()
  if (!executable) return { state: 'not-installed', detail: 'The `grok` command was not found on PATH.' }
  const connection = spawnGrok(executable, launchArgs('auto'), process.cwd(), (message) => {
    if (message.id !== undefined && message.id !== null && message.method) {
      connection.respondError(message.id, `BusyBoy does not handle ${message.method} while checking sign-in.`)
    }
  })
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      connection
        .initialize()
        .then((init) => authenticate(connection, init))
        .then((): SignInStatus => ({ state: 'signed-in' }))
        .catch(async (error: Error): Promise<SignInStatus> => {
          const stderr = error instanceof GrokExited ? (await connection.exited).stderr.trim() : ''
          const detail = stderr || error.message
          if (/not signed in|sign in|login|auth/i.test(detail)) return { state: 'signed-out', loginCommand: 'grok login' }
          return { state: 'unknown', detail }
        }),
      new Promise<SignInStatus>((resolve) => {
        timeout = setTimeout(() => resolve({ state: 'unknown', detail: 'Grok did not report its account in time.' }), SIGN_IN_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    void connection.kill()
  }
}

export const grokAdapter: ProviderAdapter = {
  start: startGrok,
  signInStatus: grokSignInStatus,
}
