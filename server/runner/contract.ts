// The provider-neutral agent contract. Everything above `server/runner/`
// (routes, actions, UI, master chat) talks to agents only through these types
// and the operations in `agent-runner.ts`. Provider adapters translate their
// own protocol into `AgentEvent` and implement `ProviderAdapter`.

export type ProviderId = 'claude' | 'codex'

/** `auto`: the provider's own auto mode (default). `full-access`: no checks, opt-in per task. */
export type PermissionMode = 'auto' | 'full-access'

export type StartAgentInput = {
  provider: ProviderId
  /** Working directory the agent runs in (a project folder or a task worktree). */
  cwd: string
  /** Extra system instructions appended to the provider's own. */
  instructions?: string
  permissionMode?: PermissionMode
  /** Provider session id to continue instead of starting a new conversation. */
  resumeSessionId?: string
  /** MCP servers the agent can use, for example busyboy's own endpoint. Their tools need no approval. */
  mcpServers?: McpServerInput[]
}

/** A streamable HTTP MCP server. Tools appear to the agent as `mcp__<name>__<tool>`. */
export type McpServerInput = {
  name: string
  url: string
  /** Sent with every request, for example the per-launch server token. */
  headers?: Record<string, string>
}

export type QuestionOption = { label: string; description?: string }

export type Question = {
  /** The full question, also the key of its answer. */
  question: string
  /** Very short tag, for example "Library". */
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export type AgentEvent =
  /** The provider process started, fresh or resumed (also after `resumeAgent`). */
  | { type: 'started'; resumed: boolean }
  /** The provider assigned or confirmed the session id used for resume. */
  | { type: 'session'; sessionId: string }
  /** A user message entered the conversation. */
  | { type: 'user-message'; text: string }
  /** Streaming piece of the assistant message being written. */
  | { type: 'text-delta'; text: string }
  /** A complete assistant message. Replaces the deltas received since the last `text`. */
  | { type: 'text'; text: string }
  /** The agent used a tool. Only a short label, for example `Bash: pnpm test`. */
  | { type: 'tool'; label: string }
  /** The agent waits until `answer()` is called with an `approval` answer. */
  | { type: 'approval'; requestId: string; title: string; detail?: string }
  /** The agent waits until `answer()` is called with a `question` answer. */
  | { type: 'question'; requestId: string; questions: Question[] }
  /** A pending approval or question was answered (or dropped by an interrupt or stop). */
  | { type: 'answered'; requestId: string }
  /** The current turn ended and the agent waits for the next user message. */
  | { type: 'turn-done'; interrupted?: boolean }
  /** The agent process ended. `finished` is false when it ended mid-turn or crashed. */
  | { type: 'stopped'; finished: boolean }
  | { type: 'error'; message: string; code?: AgentErrorCode }

export type AgentErrorCode = 'signed-out' | 'not-installed' | 'no-script' | 'provider'

export type AgentEventEnvelope = {
  /** Increases by one per agent, starting at 1. Use it to resume a stream. */
  seq: number
  at: number
  agentId: string
  event: AgentEvent
}

export type AgentAnswer =
  | { kind: 'approval'; allow: boolean; message?: string }
  /** Answers keyed by `Question.question`; several labels for a multi-select are joined with ", ". */
  | { kind: 'question'; answers: Record<string, string> }

export type AgentStatus = 'starting' | 'running' | 'waiting' | 'idle' | 'stopped'

export type AgentSnapshot = {
  id: string
  provider: ProviderId
  cwd: string
  permissionMode: PermissionMode
  status: AgentStatus
  sessionId?: string
  lastSeq: number
}

export type SignInStatus =
  | { state: 'signed-in'; account?: string }
  | { state: 'signed-out'; loginCommand: string }
  | { state: 'not-installed'; detail: string }
  | { state: 'unknown'; detail: string }

// ---- Provider side -------------------------------------------------------

export type ProviderStartOptions = Required<Pick<StartAgentInput, 'cwd' | 'permissionMode'>> &
  Pick<StartAgentInput, 'instructions' | 'resumeSessionId' | 'provider' | 'mcpServers'> & {
    /** Every event the provider produces. Call it in order; the runner stamps seq numbers. */
    emit: (event: AgentEvent) => void
  }

/** One running provider conversation. The runner never calls it after `stopped` is emitted. */
export interface ProviderSession {
  send(text: string): void
  interrupt(): Promise<void>
  /** Ask the provider to compact its context with its own compaction. */
  compact(): Promise<void>
  answer(requestId: string, answer: AgentAnswer): void
  /** End the process. The session emits `stopped` once it has ended. */
  stop(): Promise<void>
}

export interface ProviderAdapter {
  start(options: ProviderStartOptions): ProviderSession
  signInStatus(): Promise<SignInStatus>
}
