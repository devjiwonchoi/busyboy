import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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

/** Newline-delimited JSON-RPC over the stdio of one `codex app-server` process. */
class AppServerConnection {
  private nextId = 1
  private pending = new Map<number, Pending>()
  readonly exited: Promise<{ code: number | null; stderr: string }>

  constructor(
    private child: ChildProcessWithoutNullStreams,
    onMessage: (message: CodexRawMessage) => void,
  ) {
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
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
        for (const [, pending] of this.pending) pending.reject(new Error('The Codex app server exited.'))
        this.pending.clear()
        resolve({ code, stderr })
      })
    })
  }

  private write(message: object) {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
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
  const queue: string[] = []
  const requests = new Map<string, CodexRawMessage>()
  let connection: AppServerConnection | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  let inTurn = false
  let stopRequested = false
  let ready: Promise<void> | undefined

  const startNextTurn = () => {
    if (inTurn || !connection || !threadId) return
    const text = queue.shift()
    if (text === undefined) return
    inTurn = true
    connection
      .request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      })
      .then(({ turn }) => (turnId ??= turn.id))
      .catch((error: Error) => {
        inTurn = false
        emit({ type: 'error', code: 'provider', message: error.message })
        emit({ type: 'turn-done' })
        startNextTurn()
      })
  }

  const onMessage = (message: CodexRawMessage) => {
    if (message.id !== undefined) {
      const requestId = `codex-${message.id}`
      const event = CODEX_ANSWERABLE_REQUESTS.has(message.method) ? codexRequestToEvent(requestId, message) : undefined
      if (!event) {
        connection?.respondError(message.id, `Busyboy does not handle ${message.method}.`)
        return
      }
      requests.set(requestId, message)
      emit(event)
      return
    }
    // Codex runs subagents and reviewers in their own threads; only this thread is the conversation.
    const messageThread = message.params?.threadId
    if (threadId && typeof messageThread === 'string' && messageThread !== threadId) return
    if (message.method === 'turn/started') turnId = (message.params?.turn as { id: string }).id
    if (message.method === 'serverRequest/resolved') {
      // Resolved without our answer, for example by the auto reviewer or an interrupt.
      const requestId = `codex-${message.params?.requestId}`
      if (requests.delete(requestId)) emit({ type: 'answered', requestId })
      return
    }
    // `thread/started` also fires for subagent threads; the session id comes from the start or resume reply.
    if (message.method === 'thread/started') return
    for (const event of codexMessageToEvents(message)) {
      if (event.type === 'turn-done') {
        inTurn = false
        turnId = undefined
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
    if (stopRequested) connection.kill()
    ready = (async () => {
      await connection!.initialize()
      const settings = {
        cwd: options.cwd,
        ...codexThreadSettings(options.permissionMode),
        developerInstructions: options.instructions ?? null,
      }
      const response = await connection!.request<{ thread: { id: string } }>(
        options.resumeSessionId ? 'thread/resume' : 'thread/start',
        options.resumeSessionId ? { threadId: options.resumeSessionId, ...settings } : settings,
      )
      threadId = response.thread.id
      emit({ type: 'session', sessionId: threadId })
      startNextTurn()
    })()
    ready.catch(async (error: Error) => {
      if (stopRequested) return
      const status = await accountStatus(connection!).catch(() => undefined)
      if (status?.state === 'signed-out') {
        emit({ type: 'error', code: 'signed-out', message: 'Codex is not signed in. Run `codex login`.' })
      } else emit({ type: 'error', code: 'provider', message: error.message })
      connection!.kill()
    })
    const { code, stderr } = await connection.exited
    if (!stopRequested && code !== 0 && threadId) {
      emit({ type: 'error', code: 'provider', message: stderr.trim() || `The Codex app server exited with code ${code}.` })
    }
    return !inTurn
  }

  run()
    .catch((error: unknown) => {
      emit({ type: 'error', code: 'provider', message: error instanceof Error ? error.message : String(error) })
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
      queue.length = 0
      for (const [requestId, request] of requests) {
        if (request.id !== undefined) connection?.respond(request.id, codexAnswerToResult(request, { kind: 'approval', allow: false }))
        requests.delete(requestId)
        emit({ type: 'answered', requestId })
      }
      if (connection && threadId && turnId) await connection.request('turn/interrupt', { threadId, turnId }).catch(() => {})
    },
    async compact() {
      await ready
      if (!connection || !threadId) return
      await connection.request('thread/compact/start', { threadId })
    },
    answer(requestId, answer: AgentAnswer) {
      if (requestId.startsWith(CODEX_MESSAGE_QUESTION_PREFIX)) {
        // Codex waits for the answer inside the running turn; after the turn it is the next message.
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
      connection.initialize().then(() => accountStatus(connection)),
      new Promise<SignInStatus>((resolve) => {
        timeout = setTimeout(() => resolve({ state: 'unknown', detail: 'Codex did not report its account in time.' }), SIGN_IN_TIMEOUT_MS)
      }),
      connection.exited.then(({ stderr }): SignInStatus => ({ state: 'unknown', detail: stderr.trim() || 'The Codex app server exited.' })),
    ])
  } catch (error) {
    return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    connection.kill()
  }
}

export const codexAdapter: ProviderAdapter = {
  start: startCodex,
  signInStatus: codexSignInStatus,
}
