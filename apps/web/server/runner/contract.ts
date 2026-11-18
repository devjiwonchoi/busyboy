export type ProviderId = "claude" | "codex" | "grok";

export type StartAgentInput = {
  provider: ProviderId;
  cwd: string;
  instructions?: string;
  resumeSessionId?: string;
};

export type AgentEvent =
  /*why: * The provider assigned or confirmed the session id used for resume. */
  | { type: "session"; sessionId: string }
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
  /**
   * why: The current turn ended. The agent waits for the next user message, unless `more` says a
   * why: message queued during the turn starts the next turn right away.
   */
  | { type: "turn-done"; interrupted?: boolean; more?: boolean }
  /*why: * The agent process ended. `finished` is false when it ended mid-turn or crashed. */
  | { type: "stopped"; finished: boolean }
  /*why: * `lost-session`: the session to resume no longer exists, so only a new conversation can continue. */
  | { type: "error"; message: string; code?: "provider" | "lost-session" };

export type AgentStatus = "starting" | "running" | "idle" | "stopped";

export type AgentSnapshot = {
  id: string;
  provider: ProviderId;
  status: AgentStatus;
};

export type SignInStatus =
  | { state: "signed-in"; account?: string }
  | { state: "signed-out"; loginCommand: string }
  | { state: "not-installed"; detail: string }
  | { state: "unknown"; detail: string };

export type ProviderStartOptions = StartAgentInput & {
  emit: (event: AgentEvent) => void;
};

export interface ProviderSession {
  send(text: string): void;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProviderAdapter {
  start(options: ProviderStartOptions): ProviderSession;
  signInStatus(): Promise<SignInStatus>;
}
