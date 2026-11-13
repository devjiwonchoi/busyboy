import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeMessageToEvents, claudePermissionToEvent, type ClaudeRawMessage } from './claude-events'
import type { AgentAnswer, AgentEvent, ProviderAdapter, ProviderSession, ProviderStartOptions, SignInStatus } from './contract'
import { agentEnvironment, findExecutable } from './find-executable'

/** Overrides the `claude` executable that is otherwise looked up on the login-shell PATH. */
export const CLAUDE_PATH_ENV = 'BUSYBOY_CLAUDE_PATH'
const SIGN_IN_TIMEOUT_MS = 20_000

/** Streaming input for `query()`: user messages are pushed as the user sends them. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined
  private closed = false

  push(text: string) {
    if (this.closed) return
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    }
    if (this.waiting) {
      this.waiting({ value: message, done: false })
      this.waiting = undefined
    } else this.items.push(message)
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
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
    }
  }
}

async function resolveClaude() {
  return process.env[CLAUDE_PATH_ENV] || (await findExecutable('claude'))
}

/** Busyboy's MCP servers, with every tool they offer allowed without a prompt. */
function mcpOptions(servers: ProviderStartOptions['mcpServers']): Partial<Options> {
  if (!servers?.length) return {}
  return {
    mcpServers: Object.fromEntries(
      servers.map(({ name, url, headers }) => [name, { type: 'http' as const, url, headers, alwaysLoad: true }]),
    ),
    allowedTools: servers.map(({ name }) => `mcp__${name}`),
  }
}

function permissionResult(answer: AgentAnswer, input: Record<string, unknown>): PermissionResult {
  if (answer.kind === 'question') return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } }
  if (answer.allow) return { behavior: 'allow', updatedInput: input }
  return { behavior: 'deny', message: answer.message || 'The user declined this action.' }
}

function startClaude(options: ProviderStartOptions): ProviderSession {
  const { emit } = options
  const input = new MessageQueue()
  const abort = new AbortController()
  const answers = new Map<string, (answer: AgentAnswer) => void>()
  let current: Query | undefined
  let inTurn = false
  let stopRequested = false

  const canUseTool: CanUseTool = (toolName, toolInput, { signal, toolUseID, title, description }) => {
    const requestId = toolUseID || randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      // The SDK cancels the request (for example when the turn ends): close it for the runner too.
      const onAbort = () => {
        answers.delete(requestId)
        resolve({ behavior: 'deny', message: 'The request was cancelled.' })
        emit({ type: 'answered', requestId })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      answers.set(requestId, (answer) => {
        signal.removeEventListener('abort', onAbort)
        answers.delete(requestId)
        resolve(permissionResult(answer, toolInput))
      })
      emit(claudePermissionToEvent(requestId, { toolName, input: toolInput, title, description }))
    })
  }

  const run = async () => {
    const executable = await resolveClaude()
    if (!executable) {
      emit({ type: 'error', code: 'not-installed', message: 'The `claude` command was not found on the login-shell PATH.' })
      return false
    }
    current = query({
      prompt: input,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: executable,
        env: await agentEnvironment(),
        abortController: abort,
        includePartialMessages: true,
        resume: options.resumeSessionId,
        permissionMode: options.permissionMode === 'full-access' ? 'bypassPermissions' : 'auto',
        allowDangerouslySkipPermissions: options.permissionMode === 'full-access',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: options.instructions },
        canUseTool,
        ...mcpOptions(options.mcpServers),
      },
    })
    for await (const message of current) {
      for (const event of claudeMessageToEvents(message as ClaudeRawMessage)) {
        if (event.type === 'turn-done') inTurn = false
        emit(event)
      }
    }
    return !inTurn
  }

  run()
    .catch((error: unknown) => {
      if (stopRequested) return !inTurn
      emit({ type: 'error', code: 'provider', message: error instanceof Error ? error.message : String(error) })
      return false
    })
    .then((finished) => emit({ type: 'stopped', finished } satisfies AgentEvent))

  return {
    send(text) {
      inTurn = true
      input.push(text)
    },
    async interrupt() {
      for (const [requestId, resolve] of answers) {
        resolve({ kind: 'approval', allow: false, message: 'The user interrupted.' })
        emit({ type: 'answered', requestId })
      }
      if (current) {
        await current.interrupt()
        return
      }
      // The CLI is still starting and has read nothing: drop the queued message and end the turn here.
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
      answers.get(requestId)?.(answer)
    },
    async stop() {
      stopRequested = true
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
  const executable = await resolveClaude()
  if (!executable) return { state: 'not-installed', detail: 'The `claude` command was not found on the login-shell PATH.' }
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
      options: { pathToClaudeCodeExecutable: executable, env: await agentEnvironment(), abortController: abort },
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
