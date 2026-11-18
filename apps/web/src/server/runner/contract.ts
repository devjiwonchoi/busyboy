import type { UserTurn } from "./user-turn";

export type ProviderId = "claude" | "codex" | "grok";

export type PermissionMode = "auto" | "full-access";

export type StartAgentInput = {
  provider: ProviderId;
  cwd: string;
  instructions?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  // why: Adapters hand MCP servers over after start, never on the command line, so credentials stay out of process listings.
  mcpServers?: Record<string, McpServer>;
  // why: The branch is not kept, so resuming the agent branches from the original again. It has to run in the original's cwd.
  forkSessionId?: string;
  noTools?: boolean;
  alwaysAsk?: string[];
  privateFolder?: string;
  noFileEdits?: boolean;
  // why: A journey passes its own rules folder so it never reads the machine's ~/.jwn.
  rulesFolder?: string;
  recordFolder?: string;
};

export type McpServer = (
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
) & {
  trusted?: boolean;
};

export type QuestionOption = { label: string; description?: string };

export type Question = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

export type AgentEvent =
  | { type: "started"; resumed: boolean }
  /*why: * The provider assigned or confirmed the session id used for resume. */
  | { type: "session"; sessionId: string }
  /*why: * A user message entered the conversation. */
  | { type: "user-message"; text: string }
  /**
   * why: More text for the assistant text item `itemId` (one block of a reply).
   * why: Deltas arrive coalesced, a few per second, not one per token.
   */
  | { type: "text-delta"; itemId: string; text: string }
  /**
   * why: The complete text of item `itemId`, replacing what its deltas built. Sent for
   * why: text that never streamed, and for streamed text only when the final differs.
   */
  | { type: "text"; itemId: string; text: string }
  /*why: * The agent used a tool. Only a short label, for example `Bash: pnpm test`. */
  | { type: "tool"; label: string }
  /**
   * why: The agent waits until `answer()` is called with an `approval` answer.
   * why: `canAllowForSession`: the provider can remember an allow for the rest of the session.
   * why: `allowForSessionLabel`: how a card names that option when what is remembered is
   * why: narrower than every matching request (an always-ask command is remembered exactly).
   */
  | {
      type: "approval";
      requestId: string;
      title: string;
      detail?: string;
      canAllowForSession: boolean;
      allowForSessionLabel?: string;
    }
  /*why: * The agent waits until `answer()` is called with a `question` answer. */
  | { type: "question"; requestId: string; questions: Question[] }
  /*why: * A pending approval or question was answered (or dropped by an interrupt or stop). */
  | { type: "answered"; requestId: string }
  /**
   * why: The current turn ended. The agent waits for the next user message, unless `more` says a
   * why: message queued during the turn starts the next turn right away.
   */
  | { type: "turn-done"; interrupted?: boolean; more?: boolean }
  /*why: * The agent process ended. `finished` is false when it ended mid-turn or crashed. */
  | { type: "stopped"; finished: boolean }
  | { type: "error"; message: string; code?: AgentErrorCode };

/*why: * `lost-session`: the session to resume no longer exists, so only a new conversation can continue. */
export type AgentErrorCode =
  | "signed-out"
  | "not-installed"
  | "no-script"
  | "provider"
  | "lost-session";

export type AgentEventEnvelope = {
  seq: number;
  at: number;
  agentId: string;
  event: AgentEvent;
};

export type AgentAnswer =
  | { kind: "approval"; allow: boolean; forSession?: boolean; message?: string }
  /*why: * Answers keyed by `Question.question`; several labels for a multi-select are joined with ", ". */
  | { kind: "question"; answers: Record<string, string> };

export type AgentStatus = "starting" | "running" | "waiting" | "idle" | "stopped";

export type AgentSnapshot = {
  id: string;
  provider: ProviderId;
  cwd: string;
  permissionMode: PermissionMode;
  status: AgentStatus;
  sessionId?: string;
  lastSeq: number;
};

export type SignInStatus =
  | { state: "signed-in"; account?: string }
  | { state: "signed-out"; loginCommand: string }
  | { state: "not-installed"; detail: string }
  /*why: * Installed and maybe signed in, but too old for BusyBoy to run safely. */
  | { state: "outdated"; detail: string; updateCommand: string }
  | { state: "unknown"; detail: string };

export type ProviderStartOptions = Required<Pick<StartAgentInput, "cwd" | "permissionMode">> &
  Pick<
    StartAgentInput,
    | "instructions"
    | "resumeSessionId"
    | "provider"
    | "mcpServers"
    | "forkSessionId"
    | "noTools"
    | "alwaysAsk"
    | "privateFolder"
    | "noFileEdits"
    | "rulesFolder"
    | "recordFolder"
  > & {
    emit: (event: AgentEvent) => void;
  };

export interface ProviderSession {
  send(turn: UserTurn): void;
  interrupt(): Promise<void>;
  compact(): Promise<void>;
  answer(requestId: string, answer: AgentAnswer): void;
  stop(): Promise<void>;
}

export interface ProviderAdapter {
  start(options: ProviderStartOptions): ProviderSession;
  signInStatus(): Promise<SignInStatus>;
}
