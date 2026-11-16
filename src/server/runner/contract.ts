// The provider-neutral agent contract. Everything above `src/server/runner/`
// (routes, actions, UI, Director chat) talks to agents only through these types
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
  /**
   * MCP servers the agent can use, by name. Adapters hand them to the provider
   * after it starts, never on its command line or in its environment, so
   * credentials in them stay out of process listings and child processes.
   */
  mcpServers?: Record<string, McpServer>
}

export type McpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

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
  /**
   * More text for the assistant text item `itemId` (one block of a reply).
   * Deltas arrive coalesced, a few per second, not one per token.
   */
  | { type: 'text-delta'; itemId: string; text: string }
  /**
   * The complete text of item `itemId`, replacing what its deltas built. Sent for
   * text that never streamed, and for streamed text only when the final differs.
   */
  | { type: 'text'; itemId: string; text: string }
  /** The agent used a tool. Only a short label, for example `Bash: pnpm test`. */
  | { type: 'tool'; label: string }
  /**
   * The agent waits until `answer()` is called with an `approval` answer.
   * `canAllowForSession`: the provider can remember an allow for the rest of the session.
   */
  | { type: 'approval'; requestId: string; title: string; detail?: string; canAllowForSession: boolean }
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
  /** `forSession`: also allow matching requests for the rest of the session, where the request offers it. */
  | { kind: 'approval'; allow: boolean; forSession?: boolean; message?: string }
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
  /**
   * End the process and every process it started (MCP servers, background
   * shells). The session emits `stopped` once it has ended.
   */
  stop(): Promise<void>
}

export interface ProviderAdapter {
  start(options: ProviderStartOptions): ProviderSession
  signInStatus(): Promise<SignInStatus>
}
