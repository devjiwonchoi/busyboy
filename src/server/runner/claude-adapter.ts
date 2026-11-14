import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  query,
  type CanUseTool,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { alwaysAskApproval, matchAlwaysAsk } from './always-ask'
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
/** How long an always-ask approval may wait for the user: a day, so a waiting card never times out into running the action. */
const ALWAYS_ASK_TIMEOUT_S = 24 * 60 * 60

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
  /** Always-ask approvals waiting for the user, by request id. Null means it was dropped (an interrupt). */
  const asks = new Map<string, (answer: AgentAnswer | null) => void>()

  /**
   * Checks each tool call against the always-ask list before it runs. It is a
   * PreToolUse hook rather than part of canUseTool because Auto mode calls
   * canUseTool only for calls it would ask about itself, and it does not ask
   * about some irreversible ones; a hook runs for every call.
   */
  const alwaysAsk: HookCallback = async (hookInput, toolUseID, { signal }) => {
    if (hookInput.hook_event_name !== 'PreToolUse') {
      return {}
    }
    const { tool_name: toolName, tool_input: toolInput } = hookInput
    const rule = matchAlwaysAsk({ rules: options.alwaysAsk ?? [], toolName, input: toolInput, folder: options.cwd, privateFolder: options.privateFolder })
    if (!rule) {
      return {}
    }

    const requestId = `always-ask-${toolUseID ?? randomUUID()}`
    const answer = await new Promise<AgentAnswer | null>((resolve) => {
      const onAbort = () => {
        asks.delete(requestId)
        resolve(null)
        emit({ type: 'answered', requestId })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      asks.set(requestId, (value) => {
        signal.removeEventListener('abort', onAbort)
        asks.delete(requestId)
        resolve(value)
      })
      mapper.flush()
      emit(alwaysAskApproval({ requestId, toolName, input: toolInput, rule }))
    })
    const allowed = answer?.kind === 'approval' && answer.allow
    const declined = (answer?.kind === 'approval' && answer.message) || 'The user declined this action.'
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // Allowed by the user, so Auto mode does not ask a second time.
        permissionDecision: allowed ? 'allow' : 'deny',
        permissionDecisionReason: allowed ? 'The user approved this action.' : declined,
      },
    }
  }

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
        try {
          await run.initializationResult()
        } catch {
          // The session itself failed to start; run() reports why.
          return
        }
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
        // `block`: a hook that fails or times out stops the tool call instead of letting it run unasked.
        hooks:
          (options.alwaysAsk?.length || options.privateFolder) && !options.noTools
            ? { PreToolUse: [{ hooks: [alwaysAsk], timeout: ALWAYS_ASK_TIMEOUT_S, onFailure: 'block' }] }
            : undefined,
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
      // A dropped always-ask approval denies its tool call; the interrupt below then ends the turn.
      for (const [requestId, resolve] of [...asks.entries()]) {
        resolve(null)
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
      asks.get(requestId)?.(answer)
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
 * `claude update` only updates the native install. A Homebrew cask can lag
 * behind the release the SDK needs, so its users get the native build instead,
 * which `claude install` puts ahead of brew on a login shell's PATH.
 */
function updateCommandFor(executable: string) {
  let resolved = executable
  try {
    resolved = realpathSync(executable)
  } catch {
    // Keep the path as found on PATH.
  }
  return resolved.includes('/Caskroom/claude-code/') ? 'claude install latest' : 'claude update'
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
    const { account, hook_on_failure_supported, claude_code_version } = await probe.initializationResult()
    // Task agents and the Director run with a PreToolUse hook set to `onFailure: 'block'`
    // so an always-ask check that fails stops the action. A CLI that predates the option
    // would let it run, so the SDK refuses every session on it: report that here instead
    // of as signed in, or Setup passes and every turn fails. The check holds even when
    // the always-ask list is empty: the list is on by default and can change between
    // turns, and an agent that starts working and then stops on the next edit is worse
    // than Setup asking for an update once.
    if (hook_on_failure_supported !== true) {
      const version = claude_code_version ? ` ${claude_code_version}` : ''
      return {
        state: 'outdated',
        detail: `Claude Code${version} is too old to keep the always-ask list. Update it the way you installed it, then choose Check again.`,
        updateCommand: updateCommandFor(executable),
      }
    }
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
