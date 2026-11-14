import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
// Not Claude-specific: it spawns any CLI as the leader of its own process group.
import { alwaysAskApproval, matchAlwaysAsk } from './always-ask'
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

/** Overrides the `codex` executable that is otherwise looked up on PATH. */
export const CODEX_PATH_ENV = 'BUSYBOY_CODEX_PATH'
const SIGN_IN_TIMEOUT_MS = 20_000
/** How long a failed start waits to learn whether Codex is signed out. */
const ACCOUNT_CHECK_TIMEOUT_MS = 5_000
const CLIENT_INFO = { name: 'busyboy', title: 'BusyBoy', version: '0.0.0' }
/** How long a closed app server's output is still read after it exits. */
const CLOSE_WAIT_MS = 500

function resolveCodex() {
  return process.env[CODEX_PATH_ENV] || findExecutable('codex')
}

/** Thread settings for a permission mode. The reviewer is always sent so a resumed thread never keeps an old one. */
export function codexThreadSettings(mode: PermissionMode, noTools = false) {
  // Codex has no switch for "no tools" over app-server: its tools are turned
  // off one by one (noToolsConfig), and the read-only sandbox with `never`
  // keeps anything left from changing files or asking.
  if (noTools) return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' }
  return mode === 'full-access'
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' }
}

/**
 * Config for `noTools`: the shell (both kinds), apps (connectors), plugins,
 * sub-agents, tool suggestions, and web search off, and every MCP server from
 * the user's Codex config disabled for this thread. codex-cli 0.167.0
 * recognizes every key (it warns about unknown ones).
 */
async function noToolsConfig(connection: AppServerConnection, cwd: string) {
  let servers: Record<string, unknown>
  try {
    const response = await connection.request<{ config?: { mcp_servers?: Record<string, unknown> } }>('config/read', { cwd })
    servers = response.config?.mcp_servers ?? {}
  } catch (error) {
    // Without the list the user's servers would stay on, so the agent does not start.
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

/** MCP server names Codex accepts as a key in its config. */
const MCP_NAME = /^[A-Za-z0-9_-]+$/

/**
 * Per-thread config overrides for the agent's MCP servers. They travel in
 * `thread/start` and `thread/resume` over JSON-RPC, never on the command line
 * or in the app server's environment, so tokens in headers stay out of process
 * listings and child processes. Each `mcp_servers.<name>` key sets one server;
 * servers from the user's own Codex config are kept. A trusted server's tools
 * are approved without a prompt (`default_tools_approval_mode`, recognized by
 * codex-cli 0.167.0). Returns the servers Codex cannot take, with the reason.
 */
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

/** Newline-delimited JSON-RPC over the stdio of one `codex app-server` process. */
class AppServerConnection {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  readonly exited: Promise<{ code: number | null; stderr: string }>

  constructor(
    private child: GroupProcess,
    onMessage: (message: CodexRawMessage) => void,
  ) {
    // A write racing the process exit fails with EPIPE; the exit itself is reported through `exited`.
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
      // A command Codex started may hold its output open after it exits; then `close` never comes.
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
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.notify('initialized')
  }

  /**
   * Ends the app server and everything it started (commands, MCP servers):
   * SIGTERM to its process groups, then SIGKILL to what is left after a grace
   * period. The groups are found first, while Codex still runs; then its input
   * closes, which also ends a Codex that exits on its own.
   */
  async kill() {
    await this.child.stop()
    this.child.stdin.end()
  }
}

function spawnAppServer(executable: string, cwd: string, onMessage: (message: CodexRawMessage) => void) {
  // The app server and every command it runs get the agent environment, without BusyBoy's own variables.
  // Next types NODE_ENV as required in ProcessEnv; the agent environment leaves it out on purpose.
  const env = agentEnvironment() as NodeJS.ProcessEnv
  // On Windows `codex` resolves through its npm `.cmd` shim to a `.js` entry script, which needs Node to run.
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
  // Server request ids restart with every app server, so they are scoped to this one.
  const requestPrefix = `codex-${randomUUID().slice(0, 8)}-`
  const queue: string[] = []
  const requests = new Map<string, CodexRawMessage>()
  let connection: AppServerConnection | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  /** A turn (a message or a compaction) is running; new messages wait in `queue`. */
  let inTurn = false
  let interruptPending = false
  /** Identifies the latest `turn/start` request, so a late reply cannot claim a newer turn. */
  let pendingStart: object | undefined
  let stopRequested = false
  let failed = false
  let ready: Promise<void> | undefined
  /** Always-ask approvals waiting for the user, by request id. Null means it was dropped (an interrupt or stop). */
  const asks = new Map<string, (answer: AgentAnswer | null) => void>()
  const unregisterGates: (() => void)[] = []
  const alwaysAsk = !options.noTools && ((options.alwaysAsk?.length ?? 0) > 0 || Boolean(options.privateFolder))

  /** Answers this thread's always-ask hook: allowed at once unless a rule matches, then the user decides. */
  const gate = async ({ toolName, input, signal }: { toolName: string; input: unknown; signal: AbortSignal }): Promise<HookDecision> => {
    const rule = matchAlwaysAsk({ rules: options.alwaysAsk ?? [], toolName, input, folder: options.cwd, privateFolder: options.privateFolder })
    if (!rule) {
      return { allow: true, reason: '' }
    }
    const requestId = `${requestPrefix}always-ask-${randomUUID()}`
    const answer = await new Promise<AgentAnswer | null>((resolve) => {
      // The hook went away, so nobody waits for this answer any more: close its card.
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
      emit(alwaysAskApproval({ requestId, toolName, input, rule }))
    })
    asks.delete(requestId)
    if (answer?.kind === 'approval' && answer.allow) {
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
    const text = queue.shift()
    if (text === undefined) return
    inTurn = true
    const request = {}
    pendingStart = request
    connection
      .request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      })
      .then(({ turn }) => {
        // The reply can arrive after the turn already ended and the next one began.
        if (pendingStart !== request) return
        turnId ??= turn.id
        if (interruptPending) interruptTurn()
      })
      .catch((error: Error) => {
        // A stop or exit ends the session; `stopped` reports it.
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
      // The next queued message starts its turn right after this one.
      if (queue.length > 0) event = { ...event, more: true }
    }
    emit(event)
  }
  const mapper = new CodexEventMapper(onEvent, new Set(Object.keys(mcp.config).map((key) => key.slice('mcp_servers.'.length))))

  // The protocol is experimental: a message that does not have the expected shape is reported
  // (and a request refused) instead of being lost with the rest of its output.
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
      // Resolved without our answer, for example by the auto reviewer or an interrupt. Requests
      // from subagent threads are shown too, so this is checked before the thread filter.
      const requestId = `${requestPrefix}${message.params?.requestId}`
      if (requests.delete(requestId)) {
        mapper.flush()
        emit({ type: 'answered', requestId })
      }
      return
    }
    // Codex runs subagents and reviewers in their own threads; only this thread is the conversation.
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
      // Until Codex names the thread, a hook call is matched to this session by its working folder.
      if (alwaysAsk) {
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
      // The history is not needed: the runner keeps its own transcript. A
      // branch is ephemeral, so nothing is written for it and resuming the
      // agent branches from the original again, as the contract asks.
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
      if (error instanceof AppServerExited) return // Reported below with the process output.
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
    // Text that streamed before the exit is still shown.
    mapper.flush()
    mapper.dispose()
    // Only a stop ends the app server on purpose; any other exit is a failure.
    fail(stderr.trim() || `The Codex app server exited with code ${code}.`)
    return stopRequested && !inTurn && queue.length === 0
  }

  run()
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error))
      return false
    })
    .then((finished) => emit({ type: 'stopped', finished }))

  const send = (text: string) => {
    queue.push(text)
    startNextTurn()
  }

  return {
    send,
    async interrupt() {
      // Messages queued behind the turn stay queued and run next, as with Claude.
      // A dropped always-ask approval blocks its tool call.
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
        // Codex is still starting and has read nothing: drop the waiting messages and end the turn here, as Claude does.
        queue.length = 0
        emit({ type: 'turn-done' })
      }
    },
    async compact() {
      await ready?.catch(() => {})
      if (!connection || !threadId) return
      if (inTurn) throw new Error('Codex is running a turn. Compact once it ends.')
      // Compaction runs as a turn that cannot take more input, so messages wait for it.
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
        // Codex waits inside the turn (it sleeps) for the answer, which steers the turn. If the turn
        // ended in the meantime, the steer fails and the answer becomes the next message.
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

/** Starts the app server, reads the account, and ends it. No model call is made. */
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
          // An early exit explains itself on stderr.
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
