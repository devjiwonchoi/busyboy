/**
 * What only works on the user's Mac. A cloud lead gets a clear error with an
 * alternative instead of a silent failure, and the parity check reports these
 * as expected differences.
 */

export type LocalOnlyKind =
  | "computer-use"
  | "preview-local-app"
  | "keychain"
  | "mac-stdio-mcp"
  | "claude-ai-connector"
  | "claude-ai-account";

export interface LocalOnlyMatch {
  readonly kind: LocalOnlyKind;
  readonly reason: string;
}

const REASONS: Record<LocalOnlyKind, string> = {
  "computer-use": "Computer Use는 Mac 화면과 앱을 직접 다뤄요.",
  "preview-local-app": "미리보기의 로컬 앱은 Mac에서 띄운 앱이에요.",
  keychain: "키체인은 Mac에만 있어요.",
  "mac-stdio-mcp": "이 MCP 서버는 Mac에 설치된 프로그램을 stdio로 띄워요.",
  "claude-ai-connector":
    "claude.ai 커넥터는 로그인 계정에 묶여 있어서, 샌드박스의 setup-token(추론 전용)으로는 뜨지 않아요.",
  "claude-ai-account":
    "claude.ai 계정으로 로그인했을 때만 생기는 기능이에요. 샌드박스의 setup-token(추론 전용)에는 없어요.",
};

const ALTERNATIVES: Record<LocalOnlyKind, string> = {
  "computer-use": "이 태스크를 로컬로 가져와서 실행해요.",
  "preview-local-app":
    "이 태스크를 로컬로 가져오거나, 샌드박스에서 앱을 띄워 공개 포트로 확인해요.",
  keychain: "필요한 비밀값을 request_secret으로 받아 cloud_secret_save로 저장해요.",
  "mac-stdio-mcp":
    "이 태스크를 로컬로 가져와서 실행하거나, Mac에서 띄운 MCP를 릴레이로 연결해야 해요(릴레이 준비 중).",
  "claude-ai-connector": "이 태스크를 로컬로 가져와서 실행해요.",
  "claude-ai-account":
    "사용량·결제 확인은 로컬에서 해요. 웹 가져오기는 샌드박스의 WebFetch 도구가 대신해요.",
};

const match = (kind: LocalOnlyKind): LocalOnlyMatch => ({ kind, reason: REASONS[kind] });

const MAC_PATH_PREFIXES = [
  "/usr/local/",
  "/opt/homebrew/",
  "/Applications/",
  "/Users/",
  "/Library/",
  "/System/",
];

export interface McpServerConfig {
  readonly type?: string;
  readonly command?: string;
  readonly url?: string;
  readonly [key: string]: unknown;
}

export const classifyMcpServer = (
  name: string,
  config: McpServerConfig | undefined,
): LocalOnlyMatch | null => {
  if (name.startsWith("claude.ai ")) return match("claude-ai-connector");
  if (name === "computer-use") return match("computer-use");
  if (config === undefined) return null;
  const isStdio = config.type === undefined || config.type === "stdio";
  const command = config.command;
  if (
    isStdio &&
    typeof command === "string" &&
    (MAC_PATH_PREFIXES.some((prefix) => command.startsWith(prefix)) || command.includes(".app/"))
  ) {
    return match("mac-stdio-mcp");
  }
  return null;
};

const COMPUTER_USE_TOOL = /^(computer_|mcp__computer-use__|mcp__t3-code__computer_)/;
const PREVIEW_TOOL = /^(mcp__t3-code__)?(preview_|t3_preview_)/;
const KEYCHAIN_TOOL = /keychain/i;

export const classifyTool = (name: string): LocalOnlyMatch | null => {
  if (COMPUTER_USE_TOOL.test(name)) return match("computer-use");
  if (PREVIEW_TOOL.test(name)) return match("preview-local-app");
  if (KEYCHAIN_TOOL.test(name)) return match("keychain");
  return null;
};

const SANDBOX_TOKEN_NOTE = "샌드박스의 setup-token(추론 전용)은 claude.ai 계정 기능을 못 써요.";

/**
 * Init entries that differ only because the sandbox token is not a full
 * claude.ai login, each with the reason shown in the parity report.
 */
const ACCOUNT_FEATURES: Record<
  "local" | "remote",
  Partial<Record<string, Readonly<Record<string, string>>>>
> = {
  local: {
    slashCommands: {
      "extra-usage": `사용량 추가 구매 명령이에요. ${SANDBOX_TOKEN_NOTE}`,
      "usage-credits": `사용량 크레딧 명령이에요. ${SANDBOX_TOKEN_NOTE}`,
    },
    agents: {
      "web-fetch": "로컬은 웹 가져오기를 web-fetch 에이전트로, 샌드박스는 WebFetch 도구로 해요.",
    },
  },
  remote: {
    tools: {
      WebFetch: "로컬은 웹 가져오기를 web-fetch 에이전트로, 샌드박스는 WebFetch 도구로 해요.",
    },
    plugins: {
      "anthropic-skills":
        "claude.ai 계정 스킬을 샌드박스에서는 플러그인 하나로 묶어 올려요. 스킬 이름은 로컬과 같아요.",
    },
  },
};

export const classifyAccountFeature = (
  side: "local" | "remote",
  category: string,
  name: string,
): LocalOnlyMatch | null => {
  const reason = ACCOUNT_FEATURES[side][category]?.[name];
  return reason === undefined ? null : { kind: "claude-ai-account", reason };
};

export class LocalOnlyError extends Error {
  readonly kind: LocalOnlyKind;
  readonly target: string;
  readonly alternative: string;

  constructor(kind: LocalOnlyKind, target: string) {
    const alternative = ALTERNATIVES[kind];
    super(`로컬에서만 가능해요: ${target}. ${REASONS[kind]} 대안: ${alternative}`);
    this.name = "LocalOnlyError";
    this.kind = kind;
    this.target = target;
    this.alternative = alternative;
  }
}

export const localOnlyError = (kind: LocalOnlyKind, target: string) =>
  new LocalOnlyError(kind, target);

/** Throws LocalOnlyError when a cloud lead calls a Mac-only tool. */
export const assertToolAvailableInCloud = (toolName: string): void => {
  const found = classifyTool(toolName);
  if (found !== null) throw localOnlyError(found.kind, toolName);
};
