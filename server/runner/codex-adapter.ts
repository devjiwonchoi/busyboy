import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  CODEX_ANSWERABLE_REQUESTS,
  CODEX_MESSAGE_QUESTION_PREFIX,
  codexAnswerToResult,
  codexMessageToEvents,
  codexQuestionAnswerText,
  codexRequestToEvent,
  type CodexRawMessage,
} from './codex-events'
import type {
  AgentAnswer,
  PermissionMode,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  SignInStatus,
} from './contract'
import { agentEnvironment, findExecutable } from './find-executable'

/** Overrides the `codex` executable that is otherwise looked up on the login-shell PATH. */
export const CODEX_PATH_ENV = 'BUSYBOY_CODEX_PATH'
const SIGN_IN_TIMEOUT_MS = 20_000
/** How long a failed start waits to learn whether Codex is signed out. */
const ACCOUNT_CHECK_TIMEOUT_MS = 5_000
const CLIENT_INFO = { name: 'busyboy', title: 'Busyboy', version: '0.0.0' }

async function resolveCodex() {
  return process.env[CODEX_PATH_ENV] || (await findExecutable('codex'))
}

/** Thread settings for a permission mode. The reviewer is always sent so a resumed thread never keeps an old one. */
export function codexThreadSettings(mode: PermissionMode) {
  return mode === 'full-access'
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' }
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
    private child: ChildProcessWithoutNullStreams,
    onMessage: (message: CodexRawMessage) => void,
  ) {
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
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
      child.on('error', (error) => {
        stderr += error.message
      })
      child.on('close', (code) => {
        this.closed = true
        for (const [, pending] of this.pending) pending.reject(new AppServerExited())
        this.pending.clear()
        resolve({ code, stderr })
      })
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

  kill() {
    // Codex exits when its input ends; the signal covers a process that does not.
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }
}

async function spawnAppServer(executable: string, cwd: string, onMessage: (message: CodexRawMessage) => void) {
  // The app server and every command it runs get the agent environment, without busyboy's own variables.
  // Next types NODE_ENV as required in ProcessEnv; the agent environment leaves it out on purpose.
  const env = (await agentEnvironment()) as NodeJS.ProcessEnv
  // On Windows `codex` resolves through its npm `.cmd` shim to a `.js` entry script, which needs Node to run.
  const script = /\.[cm]?js$/i.test(executable)
  const command = script ? ((await findExecutable('node')) ?? 'node') : executable
  const args = script ? [executable, 'app-server'] : ['app-server']
  const child = spawn(command, args, { cwd, env, stdio: 'pipe' })
  return new AppServerConnection(child, onMessage)
}

function startCodex(options: ProviderStartOptions): ProviderSession {
  const { emit } = options
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

  const fail = (message: string, code: 'provider' | 'signed-out' = 'provider') => {
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

  const onMessage = (message: CodexRawMessage) => {
    if (message.id !== undefined) {
      const requestId = `${requestPrefix}${message.id}`
      const event = CODEX_ANSWERABLE_REQUESTS.has(message.method) ? codexRequestToEvent(requestId, message) : undefined
      if (!event) {
        connection?.respondError(message.id, `Busyboy does not handle ${message.method}.`)
        return
      }
      requests.set(requestId, message)
      emit(event)
      return
    }
    if (message.method === 'serverRequest/resolved') {
      // Resolved without our answer, for example by the auto reviewer or an interrupt. Requests
      // from subagent threads are shown too, so this is checked before the thread filter.
      const requestId = `${requestPrefix}${message.params?.requestId}`
      if (requests.delete(requestId)) emit({ type: 'answered', requestId })
      return
    }
    // Codex runs subagents and reviewers in their own threads; only this thread is the conversation.
    const messageThread = message.params?.threadId
    if (threadId && typeof messageThread === 'string' && messageThread !== threadId) return
    if (message.method === 'turn/started') {
      turnId = (message.params?.turn as { id: string }).id
      if (interruptPending) interruptTurn()
    }
    for (const event of codexMessageToEvents(message)) {
      if (event.type === 'turn-done') {
        pendingStart = undefined
        inTurn = false
        turnId = undefined
        interruptPending = false
        // The next queued message starts its turn right after this one.
        if (queue.length > 0) {
          emit({ ...event, more: true })
          continue
        }
      }
      emit(event)
    }
    if (message.method === 'turn/completed') startNextTurn()
  }

  const run = async () => {
    const executable = await resolveCodex()
    if (!executable) {
      emit({ type: 'error', code: 'not-installed', message: 'The `codex` command was not found on the login-shell PATH.' })
      return false
    }
    connection = await spawnAppServer(executable, options.cwd, onMessage)
    const current = connection
    if (stopRequested) current.kill()
    ready = (async () => {
      await current.initialize()
      const settings = {
        cwd: options.cwd,
        ...codexThreadSettings(options.permissionMode),
        developerInstructions: options.instructions ?? null,
      }
      const response = await current.request<{ thread: { id: string } }>(
        options.resumeSessionId ? 'thread/resume' : 'thread/start',
        // The history is not needed: the runner keeps its own transcript.
        options.resumeSessionId ? { threadId: options.resumeSessionId, excludeTurns: true, ...settings } : settings,
      )
      threadId = response.thread.id
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
      else fail(error.message)
      current.kill()
    })
    const { code, stderr } = await current.exited
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
      for (const [requestId, request] of requests) {
        if (request.id !== undefined) connection?.respond(request.id, codexAnswerToResult(request, { kind: 'approval', allow: false }))
        requests.delete(requestId)
        emit({ type: 'answered', requestId })
      }
      if (turnId) interruptTurn()
      // The turn was requested but Codex has not named it yet: interrupt once it does.
      else if (inTurn) interruptPending = true
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
      connection?.respond(request.id, codexAnswerToResult(request, answer))
    },
    async stop() {
      stopRequested = true
      connection?.kill()
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
  const executable = await resolveCodex()
  if (!executable) return { state: 'not-installed', detail: 'The `codex` command was not found on the login-shell PATH.' }
  const connection = await spawnAppServer(executable, process.cwd(), () => {})
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
    connection.kill()
  }
}

export const codexAdapter: ProviderAdapter = {
  start: startCodex,
  signInStatus: codexSignInStatus,
}
