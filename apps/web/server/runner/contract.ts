import type { UserTurn } from "./user-turn";

export type ProviderId = "claude" | "codex" | "grok";

export type PermissionMode = "auto" | "full-access";

export type StartAgentInput = {
  provider: ProviderId;
  cwd: string;
  instructions?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  mcpServers?: Record<string, McpServer>;
  forkSessionId?: string;
  noTools?: boolean;
  alwaysAsk?: string[];
  privateFolder?: string;
  noFileEdits?: boolean;
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
  | { type: "session"; sessionId: string }
  | { type: "user-message"; text: string }
  | { type: "text-delta"; itemId: string; text: string }
  | { type: "text"; itemId: string; text: string }
  | { type: "tool"; label: string }
  | {
      type: "approval";
      requestId: string;
      title: string;
      detail?: string;
      canAllowForSession: boolean;
      allowForSessionLabel?: string;
    }
  | { type: "question"; requestId: string; questions: Question[] }
  | { type: "answered"; requestId: string }
  | { type: "turn-done"; interrupted?: boolean; more?: boolean }
  | { type: "stopped"; finished: boolean }
  | { type: "error"; message: string; code?: AgentErrorCode };

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
