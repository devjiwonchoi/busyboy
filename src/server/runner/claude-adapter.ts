import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeEventMapper, claudePermissionToEvent, type ClaudeRawMessage } from './claude-events'
import { spawnClaudeProcess, type ClaudeProcess } from './claude-process'
import type {
  AgentAnswer,
  AgentEvent,
  McpServer,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  SignInStatus,
} from './contract'
import { agentEnvironment, findExecutable } from './find-executable'

/** Overrides the `claude` executable that is otherwise looked up on PATH. */
export const CLAUDE_PATH_ENV = 'BUSYBOY_CLAUDE_PATH'
const SIGN_IN_TIMEOUT_MS = 20_000

/** Streaming input for `query()`: user messages are pushed as the user sends them. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined
  private closed = false
  private held = true

  push(text: string) {
    if (this.closed) return
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    }
    if (this.waiting && !this.held) {
      this.waiting({ value: message, done: false })
      this.waiting = undefined
    } else this.items.push(message)
  }

  /** Whether messages still wait for `release`. */
  get isHeld() {
    return this.held
  }

  /** Lets the CLI read messages. Until then they wait, so setup can finish before the first turn. */
  release() {
    this.held = false
    const item = this.waiting && this.items.shift()
    if (item) {
      this.waiting!({ value: item, done: false })
      this.waiting = undefined
    }
  }

  /** Drops messages the CLI has not read yet. */
  clear() {
    this.items = []
  }

  close() {
    this.closed = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.held ? undefined : this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
    }
  }
}

function resolveClaude() {
  return process.env[CLAUDE_PATH_ENV] || findExecutable('claude')
}

type OpenRequest = {
  input: Record<string, unknown>
  /**
   * The CLI's permission updates that stop this request from asking again,
   * kept to the session. Empty when the CLI offers none, or when remembering
   * would grant more than this request; then the request cannot be allowed for the session.
   */
  sessionPermissions: PermissionUpdate[]
  resolve: (result: PermissionResult) => void
}

function permissionResult(answer: AgentAnswer, request: OpenRequest): PermissionResult {
  if (answer.kind === 'question') return { behavior: 'allow', updatedInput: { ...request.input, answers: answer.answers } }
  if (!answer.allow) return { behavior: 'deny', message: answer.message || 'The user declined this action.' }
  const forSession = answer.forSession && request.sessionPermissions.length > 0
  return {
    behavior: 'allow',
    updatedInput: request.input,
    ...(forSession ? { updatedPermissions: request.sessionPermissions } : {}),
  }
}

function toSdkMcpServers(servers: Record<string, McpServer>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === 'stdio'
        ? { type: 'stdio', command: server.command, args: server.args, env: server.env }
        : { type: server.type, url: server.url, headers: server.headers },
    ]),
  )
}

/**
 * Continue, branch, or start a session. A branch (`forkSessionId`) is
 * `resume` + `forkSession`, which copies the history into a new session id
 * and leaves the original file untouched, plus `persistSession: false`, so no
 * file is written for the branch at all.
 */
function sessionOptions({ resumeSessionId, forkSessionId }: ProviderStartOptions): Partial<Options> {
  if (forkSessionId) return { resume: forkSessionId, forkSession: true, persistSession: false }
  return { resume: resumeSessionId }
}

/**
 * No tools at all. `tools: []` turns off only the built-in ones; the user's
 * own MCP servers (settings, plugins, connectors) would still load, so they
 * are left out and refused too. Verified with CLI 2.1.311: a branch of a
 * session that used tools still answers with no tools defined.
 */
const NO_TOOLS: Partial<Options> = { tools: [], strictMcpConfig: true, disallowedTools: ['mcp__*'] }

function startClaude(options: ProviderStartOptions): ProviderSession {
  const { emit } = options
  const input = new MessageQueue()
  const abort = new AbortController()
  const requests = new Map<string, OpenRequest>()
  const mapper = new ClaudeEventMapper(emit)
  let current: Query | undefined
  let cli: ClaudeProcess | undefined
  let inTurn = false
  let stopRequested = false

  const canUseTool: CanUseTool = (
    toolName,
    toolInput,
    { signal, toolUseID, title, description, suggestions, suppressAlwaysAllowRule },
  ) => {
    const requestId = toolUseID || randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      // The SDK cancels the request (for example when the turn ends): close it for the runner too.
      const onAbort = () => {
        requests.delete(requestId)
        resolve({ behavior: 'deny', message: 'The request was cancelled.' })
        emit({ type: 'answered', requestId })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // Only rules and directories: a suggested mode change would leave the agent
      // in a different permission mode than the one it was started with.
      const sessionPermissions = suppressAlwaysAllowRule
        ? []
        : (suggestions ?? [])
            .filter((suggestion) => suggestion.type === 'addRules' || suggestion.type === 'addDirectories')
            .map((suggestion) => ({ ...suggestion, destination: 'session' as const }))
      requests.set(requestId, {
        input: toolInput,
        sessionPermissions,
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort)
          requests.delete(requestId)
          resolve(result)
        },
      })
      mapper.flush()
      emit(
        claudePermissionToEvent(requestId, {
          toolName,
          input: toolInput,
          title,
          description,
          suggestions: sessionPermissions,
        }),
      )
    })
  }

  /** Hands the MCP servers to the CLI over its control channel, then lets the first message through. */
  const registerMcpServers = async (run: Query) => {
    try {
      if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
        await run.initializationResult()
        const result = await run.setMcpServers(toSdkMcpServers(options.mcpServers))
        // Errors can echo headers or tokens; report only the server names.
        const failed = Object.keys(result.errors)
        if (failed.length > 0) {
          emit({ type: 'error', code: 'provider', message: `These MCP servers could not start: ${failed.join(', ')}.` })
        }
      }
    } catch {
      if (!stopRequested) {
        const names = Object.keys(options.mcpServers ?? {}).join(', ')
        emit({ type: 'error', code: 'provider', message: `These MCP servers could not be added: ${names}.` })
      }
    } finally {
      input.release()
    }
  }

  const run = async () => {
    const executable = resolveClaude()
    if (!executable) {
      emit({ type: 'error', code: 'not-installed', message: 'The `claude` command was not found on PATH.' })
      return false
    }
    current = query({
      prompt: input,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: executable,
        env: agentEnvironment(),
        abortController: abort,
        includePartialMessages: true,
        ...sessionOptions(options),
        ...(options.noTools ? NO_TOOLS : {}),
        permissionMode: options.noTools
          ? 'dontAsk'
          : options.permissionMode === 'full-access'
            ? 'bypassPermissions'
            : 'auto',
        allowDangerouslySkipPermissions: options.permissionMode === 'full-access',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: options.instructions },
        canUseTool,
        // The servers are added after start (registerMcpServers), but the rule
        // can name them now: every tool of a trusted server runs without a prompt.
        allowedTools: Object.entries(options.mcpServers ?? {})
          .filter(([, server]) => server.trusted)
          .map(([name]) => `mcp__${name}`),
        spawnClaudeCodeProcess: (spawnOptions) => (cli = spawnClaudeProcess(spawnOptions)),
      },
    })
    void registerMcpServers(current)
    for await (const message of current) {
      if (message.type === 'result') inTurn = false
      mapper.push(message as ClaudeRawMessage)
    }
    return !inTurn
  }

  run()
    .catch((error: unknown) => {
      if (stopRequested) return !inTurn
      mapper.flush()
      const message = error instanceof Error ? error.message : String(error)
      // A CLI that fails to start explains why only on stderr.
      const stderr = cli?.stderrTail()
      emit({ type: 'error', code: 'provider', message: stderr ? `${message}\n${stderr}` : message })
      return false
    })
    .then((finished) => {
      mapper.flush()
      mapper.dispose()
      // The SDK stream can end while the CLI still runs; end it and what it started.
      void cli?.stop()
      emit({ type: 'stopped', finished } satisfies AgentEvent)
    })

  return {
    send(text) {
      inTurn = true
      input.push(text)
    },
    async interrupt() {
      // A denial with `interrupt` ends the turn by itself; a second interrupt
      // could reach the CLI after it has started the next queued message.
      const open = [...requests.entries()]
      for (const [requestId, request] of open) {
        request.resolve({ behavior: 'deny', message: 'The user interrupted.', interrupt: true })
        emit({ type: 'answered', requestId })
      }
      if (open.length > 0) return
      if (!input.isHeld) {
        await current?.interrupt()
        return
      }
      // The CLI is still starting (or adding MCP servers) and has read nothing:
      // drop the queued message and end the turn here.
      input.clear()
      if (inTurn) {
        inTurn = false
        emit({ type: 'turn-done' })
      }
    },
    async compact() {
      inTurn = true
      input.push('/compact')
    },
    answer(requestId, answer) {
      const request = requests.get(requestId)
      request?.resolve(permissionResult(answer, request))
    },
    async stop() {
      stopRequested = true
      // Ends the commands the CLI detached while they are still its descendants,
      // then the CLI's own process group (see claude-process.ts).
      await cli?.stop()
      input.close()
      abort.abort()
    },
  }
}

/**
 * Starts Claude Code without sending a prompt: the CLI completes its
 * initialization (which reports the account) but never calls the API.
 */
async function claudeSignInStatus(): Promise<SignInStatus> {
  const executable = resolveClaude()
  if (!executable) return { state: 'not-installed', detail: 'The `claude` command was not found on PATH.' }
  const abort = new AbortController()
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) =>
          abort.signal.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true }),
        ),
    }),
  }
  const timeout = setTimeout(() => abort.abort(), SIGN_IN_TIMEOUT_MS)
  try {
    const probe = query({
      prompt: idle,
      options: { pathToClaudeCodeExecutable: executable, env: agentEnvironment(), abortController: abort },
    })
    const { account } = await probe.initializationResult()
    if (account.apiProvider && account.apiProvider !== 'firstParty') return { state: 'signed-in', account: account.apiProvider }
    const hasKey = Boolean(account.apiKeySource) && account.apiKeySource !== 'none'
    // Require a positive signal: a missing tokenSource does not prove a sign-in.
    const hasToken = Boolean(account.tokenSource) && account.tokenSource !== 'none'
    if (hasToken || hasKey || account.email) {
      return { state: 'signed-in', account: account.email ?? account.organization }
    }
    return { state: 'signed-out', loginCommand: 'claude /login' }
  } catch (error) {
    return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
}

export const claudeAdapter: ProviderAdapter = {
  start: startClaude,
  signInStatus: claudeSignInStatus,
}
