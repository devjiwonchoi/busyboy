import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
// Not Claude-specific: it spawns any CLI as the leader of its own process group.
import { alwaysAskApproval, createAllowedCalls, matchAlwaysAsk } from './always-ask'
import { checkUserRules, userRuleApproval, userRulesHookNeeded } from './user-rules'
import { folderKey, registerGate, threadKey, trustedHookConfig, type HookDecision } from './codex-always-ask'
import { spawnClaudeProcess as spawnProcessGroup, type ClaudeProcess as GroupProcess } from './claude-process'
import {
  CODEX_ANSWERABLE_REQUESTS,
  CODEX_MESSAGE_QUESTION_PREFIX,
  codexAnswerToResult,
  codexAutoReply,
  CodexEventMapper,
  codexQuestionAnswerText,
  codexRequestToEvent,
  type CodexRawMessage,
} from './codex-events'
import { codexInput, modelText, textTurn, type UserTurn } from './user-turn'
import type {
  AgentAnswer,
  AgentEvent,
  McpServer,
  PermissionMode,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  SignInStatus,
} from './contract'
import { agentEnvironment, findExecutable } from './find-executable'

export const CODEX_PATH_ENV = 'BUSYBOY_CODEX_PATH'
const SIGN_IN_TIMEOUT_MS = 20_000
const ACCOUNT_CHECK_TIMEOUT_MS = 5_000
const CLIENT_INFO = { name: 'busyboy', title: 'BusyBoy', version: '0.0.0' }
const CLOSE_WAIT_MS = 500

function resolveCodex() {
  return process.env[CODEX_PATH_ENV] || findExecutable('codex')
}

export function codexThreadSettings(mode: PermissionMode, noTools = false) {
  // Codex has no switch for no tools over app-server.
  if (noTools) return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' }
  return mode === 'full-access'
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' }
}

// codex-cli 0.167.0 warns about unknown config keys, and every key here is one it recognizes.
async function noToolsConfig(connection: AppServerConnection, cwd: string) {
  let servers: Record<string, unknown>
  try {
    const response = await connection.request<{ config?: { mcp_servers?: Record<string, unknown> } }>('config/read', { cwd })
    servers = response.config?.mcp_servers ?? {}
  } catch (error) {
    throw new Error(`Codex could not list its MCP servers to turn them off: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    'features.shell_tool': false,
    'features.unified_exec': false,
    'features.apps': false,
    'features.plugins': false,
    'features.multi_agent': false,
    'features.tool_suggest': false,
    web_search: 'disabled',
    ...Object.fromEntries(Object.keys(servers).map((name) => [`mcp_servers.${name}.enabled`, false])),
  }
}

const MCP_NAME = /^[A-Za-z0-9_-]+$/

// MCP config travels in thread/start over JSON-RPC, so tokens stay out of the command line and child processes.
export function codexMcpConfig(servers: Record<string, McpServer> = {}) {
  const config: Record<string, unknown> = {}
  const skipped: string[] = []
  for (const [name, server] of Object.entries(servers)) {
    const approval = server.trusted ? { default_tools_approval_mode: 'approve' } : {}
    if (!MCP_NAME.test(name)) skipped.push(`The MCP server name ${name} can only use letters, digits, - and _ for Codex.`)
    else if (server.type === 'stdio') config[`mcp_servers.${name}`] = { command: server.command, args: server.args ?? [], env: server.env ?? {}, ...approval }
    else if (server.type === 'http') config[`mcp_servers.${name}`] = { url: server.url, http_headers: server.headers ?? {}, ...approval }
    else skipped.push(`Codex cannot use the MCP server ${name}: it only connects to stdio and HTTP servers, not SSE.`)
  }
  return { config, skipped }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

class AppServerExited extends Error {
  constructor() {
    super('The Codex app server exited.')
  }
}

class AppServerConnection {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  readonly exited: Promise<{ code: number | null; stderr: string }>

  constructor(
    private child: GroupProcess,
    onMessage: (message: CodexRawMessage) => void,
  ) {
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      let message: CodexRawMessage & { result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method === undefined && typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending?.reject(new Error(message.error.message ?? 'Codex request failed.'))
        else pending?.resolve(message.result)
      } else if (message.method) onMessage(message)
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
        for (const [, pending] of this.pending) pending.reject(new AppServerExited())
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
    if (this.closed) return Promise.reject(new AppServerExited())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: string | number, result: unknown) {
    this.write({ id, result })
  }

  respondError(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } })
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: CLIENT_INFO,
      // `requiredHumanApproval` is what makes Codex deliver a `humanCommand` checkpoint.
      // Without it the command is rejected and the user is never asked.
      capabilities: { experimentalApi: true, requestAttestation: false, requiredHumanApproval: true },
    })
    this.notify('initialized')
  }

  // The groups are found while Codex still runs. Closing its input also ends a Codex that exits on its own.
  async kill() {
    await this.child.stop()
    this.child.stdin.end()
  }
}

function spawnAppServer(executable: string, cwd: string, onMessage: (message: CodexRawMessage) => void) {
  const env = agentEnvironment() as NodeJS.ProcessEnv
  const script = /\.[cm]?js$/i.test(executable)
  const command = script ? (findExecutable('node') ?? 'node') : executable
  const args = script ? [executable, 'app-server'] : ['app-server']
  // Never aborted: `kill()` ends the process group instead. Windows has no process groups: there
  // only the process itself is killed, and an npm shim's native app server ends when its input closes.
  const child = spawnProcessGroup({ command, args, cwd, env, signal: new AbortController().signal })
  return new AppServerConnection(child, onMessage)
}

function startCodex(options: ProviderStartOptions): ProviderSession {
  const { emit } = options
  const mcp = codexMcpConfig(options.mcpServers)
  const requestPrefix = `codex-${randomUUID().slice(0, 8)}-`
  const queue: UserTurn[] = []
  const requests = new Map<string, CodexRawMessage>()
  let connection: AppServerConnection | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  let inTurn = false
  let interruptPending = false
  let pendingStart: object | undefined
  let stopRequested = false
  let failed = false
  let ready: Promise<void> | undefined
  const asks = new Map<string, (answer: AgentAnswer | null) => void>()
  const allowedCalls = createAllowedCalls()
  const unregisterGates: (() => void)[] = []
  const alwaysAsk =
    !options.noTools &&
    ((options.alwaysAsk?.length ?? 0) > 0 || Boolean(options.privateFolder) || Boolean(options.noFileEdits) || userRulesHookNeeded(options.rulesFolder))

  const ask = (requestId: string, event: Extract<AgentEvent, { type: 'approval' }>, signal: AbortSignal) =>
    new Promise<AgentAnswer | null>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          if (asks.delete(requestId)) {
            resolve(null)
            emit({ type: 'answered', requestId })
          }
        },
        { once: true },
      )
      asks.set(requestId, resolve)
      mapper.flush()
      emit(event)
    })

  const gate = async ({ toolName, input, cwd, signal }: { toolName: string; input: unknown; cwd?: string; signal: AbortSignal }): Promise<HookDecision> => {
    const folder = cwd || options.cwd
    const userRule = await checkUserRules({ rulesFolder: options.rulesFolder, toolName, input, cwd: folder, recordFolder: options.recordFolder })
    if (userRule.ask) {
      const call = { toolName, input, rule: userRule.ruleKey, cwd: folder }
      if (!(userRule.remember && allowedCalls.has(call))) {
        const requestId = `${requestPrefix}user-rule-${randomUUID()}`
        const answer = await ask(
          requestId,
          userRuleApproval({ requestId, toolName, input, detail: userRule.detail, remember: userRule.remember }),
          signal,
        )
        asks.delete(requestId)
        if (!(answer?.kind === 'approval' && answer.allow)) {
          return { allow: false, reason: (answer?.kind === 'approval' && answer.message) || 'The user declined this action.' }
        }
        if (answer.forSession && userRule.remember) allowedCalls.add(call)
      }
    }
    const rule = matchAlwaysAsk({ rules: options.alwaysAsk ?? [], toolName, input, folder: options.cwd, recordFolder: options.recordFolder, privateFolder: options.privateFolder, noFileEdits: options.noFileEdits })
    const call = { toolName, input, rule: rule ?? '', cwd: folder }
    if (!rule || allowedCalls.has(call)) {
      return { allow: true, reason: '' }
    }
    const requestId = `${requestPrefix}always-ask-${randomUUID()}`
    const answer = await ask(requestId, alwaysAskApproval({ requestId, toolName, input, rule }), signal)
    asks.delete(requestId)
    if (answer?.kind === 'approval' && answer.allow) {
      if (answer.forSession) allowedCalls.add(call)
      return { allow: true, reason: '' }
    }
    return { allow: false, reason: (answer?.kind === 'approval' && answer.message) || 'The user declined this action.' }
  }

  const dropAsks = () => {
    for (const [requestId, resolve] of [...asks.entries()]) {
      asks.delete(requestId)
      resolve(null)
      emit({ type: 'answered', requestId })
    }
  }

  const fail = (message: string, code: 'provider' | 'signed-out' | 'lost-session' = 'provider') => {
    if (failed || stopRequested) return
    failed = true
    emit({ type: 'error', code, message })
  }

  const interruptTurn = () => {
    if (!connection || !threadId || !turnId) return
    interruptPending = false
    connection.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }

  const startNextTurn = () => {
    if (inTurn || !connection || !threadId) return
    const turn = queue.shift()
    if (turn === undefined) return
    inTurn = true
    const request = {}
    pendingStart = request
    const text = modelText(turn)
    connection
      .request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: codexInput(text ? turn : { ...turn, text: ' ' }),
      })
      .then(({ turn }) => {
        if (pendingStart !== request) return
        turnId ??= turn.id
        if (interruptPending) interruptTurn()
      })
      .catch((error: Error) => {
        if (stopRequested || error instanceof AppServerExited) return
        inTurn = false
        interruptPending = false
        emit({ type: 'error', code: 'provider', message: error.message })
        emit(queue.length > 0 ? { type: 'turn-done', more: true } : { type: 'turn-done' })
        startNextTurn()
      })
  }

  const onEvent = (event: AgentEvent) => {
    if (event.type === 'turn-done') {
      pendingStart = undefined
      inTurn = false
      turnId = undefined
      interruptPending = false
      if (queue.length > 0) event = { ...event, more: true }
    }
    emit(event)
  }
  const mapper = new CodexEventMapper(onEvent)

  const onMessage = (message: CodexRawMessage) => {
    try {
      handleMessage(message)
    } catch (error) {
      if (message.id !== undefined) connection?.respondError(message.id, `BusyBoy could not read ${message.method}.`)
      mapper.flush()
      emit({
        type: 'error',
        code: 'provider',
        message: `BusyBoy could not read a Codex ${message.method} message: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const handleMessage = (message: CodexRawMessage) => {
    if (message.id !== undefined) {
      const requestId = `${requestPrefix}${message.id}`
      const auto = codexAutoReply(message)
      if (auto) {
        connection?.respond(message.id, auto.result)
        mapper.flush()
        emit({ type: 'error', code: 'provider', message: auto.notice })
        return
      }
      const event = CODEX_ANSWERABLE_REQUESTS.has(message.method) ? codexRequestToEvent(requestId, message) : undefined
      if (!event) {
        connection?.respondError(message.id, `BusyBoy does not handle ${message.method}.`)
        return
      }
      requests.set(requestId, message)
      mapper.flush()
      emit(event)
      return
    }
    if (message.method === 'serverRequest/resolved') {
      const requestId = `${requestPrefix}${message.params?.requestId}`
      if (requests.delete(requestId)) {
        mapper.flush()
        emit({ type: 'answered', requestId })
      }
      return
    }
    const messageThread = message.params?.threadId
    if (threadId && typeof messageThread === 'string' && messageThread !== threadId) return
    if (message.method === 'turn/started') {
      turnId = (message.params?.turn as { id: string }).id
      if (interruptPending) interruptTurn()
    }
    mapper.push(message)
    if (message.method === 'turn/completed') startNextTurn()
  }

  const run = async () => {
    const executable = resolveCodex()
    if (!executable) {
      emit({ type: 'error', code: 'not-installed', message: 'The `codex` command was not found on PATH.' })
      return false
    }
    for (const notice of mcp.skipped) emit({ type: 'error', code: 'provider', message: notice })
    connection = spawnAppServer(executable, options.cwd, onMessage)
    const current = connection
    if (stopRequested) void current.kill()
    ready = (async () => {
      await current.initialize()
      // A subagent's folder is the project checkout, where other agents work, so it is matched by thread only.
      if (alwaysAsk && !options.noFileEdits) {
        unregisterGates.push(registerGate({ key: folderKey(options.cwd), gate }))
      }
      const hook = alwaysAsk
        ? await trustedHookConfig({ request: (method, params) => current.request(method, params), cwd: options.cwd, executable })
        : undefined
      const settings = {
        cwd: options.cwd,
        ...codexThreadSettings(options.permissionMode, options.noTools),
        developerInstructions: options.instructions ?? null,
        config: options.noTools ? await noToolsConfig(current, options.cwd) : { ...mcp.config, ...hook?.config },
      }
      const [method, params] = options.forkSessionId
        ? ['thread/fork', { threadId: options.forkSessionId, ephemeral: true, excludeTurns: true, ...settings }]
        : options.resumeSessionId
          ? ['thread/resume', { threadId: options.resumeSessionId, excludeTurns: true, ...settings }]
          : ['thread/start', settings]
      const response = await current.request<{ thread: { id: string } }>(method, params)
      await hook?.verify(response.thread.id)
      threadId = response.thread.id
      if (alwaysAsk) {
        unregisterGates.push(registerGate({ key: threadKey(threadId), gate }))
      }
      emit({ type: 'session', sessionId: threadId })
      startNextTurn()
    })()
    ready.catch(async (error: Error) => {
      if (error instanceof AppServerExited) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const status = await Promise.race([
        accountStatus(current).catch(() => undefined),
        new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ACCOUNT_CHECK_TIMEOUT_MS))),
      ])
      clearTimeout(timer)
      if (status?.state === 'signed-out') fail('Codex is not signed in. Run `codex login`.', 'signed-out')
      // codex-cli 0.167.0's answer to resuming or branching from a thread it does not have.
      else if ((options.resumeSessionId || options.forkSessionId) && /no rollout found for thread id/i.test(error.message)) {
        fail(error.message, 'lost-session')
      } else fail(error.message)
      void current.kill()
    })
    const { code, stderr } = await current.exited
    for (const unregister of unregisterGates) {
      unregister()
    }
    dropAsks()
    mapper.flush()
    mapper.dispose()
    fail(stderr.trim() || `The Codex app server exited with code ${code}.`)
    return stopRequested && !inTurn && queue.length === 0
  }

  run()
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error))
      return false
    })
    .then((finished) => emit({ type: 'stopped', finished }))

  const send = (turn: UserTurn | string) => {
    queue.push(typeof turn === 'string' ? textTurn(turn) : turn)
    startNextTurn()
  }

  return {
    send,
    async interrupt() {
      dropAsks()
      for (const [requestId, request] of requests) {
        if (request.id !== undefined) connection?.respond(request.id, codexAnswerToResult(request, { kind: 'approval', allow: false }))
        requests.delete(requestId)
        emit({ type: 'answered', requestId })
      }
      if (turnId) interruptTurn()
      // The turn was requested but Codex has not named it yet: interrupt once it does.
      else if (inTurn) interruptPending = true
      else if (!threadId && queue.length > 0) {
        queue.length = 0
        emit({ type: 'turn-done' })
      }
    },
    async compact() {
      await ready?.catch(() => {})
      if (!connection || !threadId) return
      if (inTurn) throw new Error('Codex is running a turn. Compact once it ends.')
      inTurn = true
      try {
        await connection.request('thread/compact/start', { threadId })
      } catch (error) {
        inTurn = false
        interruptPending = false
        emit(queue.length > 0 ? { type: 'turn-done', more: true } : { type: 'turn-done' })
        startNextTurn()
        throw error
      }
    },
    answer(requestId, answer: AgentAnswer) {
      const ask = asks.get(requestId)
      if (ask) {
        ask(answer)
        return
      }
      if (requestId.startsWith(CODEX_MESSAGE_QUESTION_PREFIX)) {
        const text = codexQuestionAnswerText(answer)
        if (!connection || !threadId || !turnId) return send(text)
        const input = [{ type: 'text', text, text_elements: [] }]
        connection.request('turn/steer', { threadId, input, expectedTurnId: turnId }).catch(() => send(text))
        return
      }
      const request = requests.get(requestId)
      if (!request || request.id === undefined) return
      requests.delete(requestId)
      const result = codexAnswerToResult(request, answer)
      if ((result as { decision?: unknown }).decision === 'cancel') mapper.deniedWithCancel()
      connection?.respond(request.id, result)
    },
    async stop() {
      stopRequested = true
      await connection?.kill()
    },
  }
}

async function accountStatus(connection: AppServerConnection): Promise<SignInStatus> {
  const { account, requiresOpenaiAuth } = await connection.request<{
    account: { type: string; email?: string | null } | null
    requiresOpenaiAuth: boolean
  }>('account/read', {})
  if (account) return { state: 'signed-in', account: account.email ?? account.type }
  if (!requiresOpenaiAuth) return { state: 'signed-in' }
  return { state: 'signed-out', loginCommand: 'codex login' }
}

async function codexSignInStatus(): Promise<SignInStatus> {
  const executable = resolveCodex()
  if (!executable) return { state: 'not-installed', detail: 'The `codex` command was not found on PATH.' }
  const connection = spawnAppServer(executable, process.cwd(), () => {})
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      connection
        .initialize()
        .then(() => accountStatus(connection))
        .catch(async (error: Error): Promise<SignInStatus> => {
          const stderr = error instanceof AppServerExited ? (await connection.exited).stderr.trim() : ''
          return { state: 'unknown', detail: stderr || error.message }
        }),
      new Promise<SignInStatus>((resolve) => {
        timeout = setTimeout(() => resolve({ state: 'unknown', detail: 'Codex did not report its account in time.' }), SIGN_IN_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    void connection.kill()
  }
}

export const codexAdapter: ProviderAdapter = {
  start: startCodex,
  signInStatus: codexSignInStatus,
}
