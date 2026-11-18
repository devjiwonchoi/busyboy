import type { UserTurn } from "./user-turn";

export type ProviderId = "claude" | "codex" | "grok";

export type StartAgentInput = {
  provider: ProviderId;
  cwd: string;
  instructions?: string;
  resumeSessionId?: string;
};

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; itemId: string; text: string }
  | { type: "text"; itemId: string; text: string }
  | { type: "turn-done"; interrupted?: boolean; more?: boolean }
  | { type: "stopped"; finished: boolean }
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
  send(turn: UserTurn): void;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProviderAdapter {
  start(options: ProviderStartOptions): ProviderSession;
  signInStatus(): Promise<SignInStatus>;
}
