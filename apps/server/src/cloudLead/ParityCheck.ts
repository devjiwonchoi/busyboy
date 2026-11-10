/**
 * Starts claude on the Mac and in the sandbox, reads each one's SDK init
 * message, and compares them item by item. Differences that come from the
 * local-only list are tagged as expected.
 */
import type { LocalHost } from "./LocalHost.ts";
import {
  classifyAccountFeature,
  classifyMcpServer,
  classifyTool,
  type LocalOnlyMatch,
} from "./localOnly.ts";
import { shellQuote } from "./EnvironmentSync.ts";
import type { SandboxHandle } from "./SandboxClient.ts";

export interface ClaudeInit {
  readonly skills: ReadonlyArray<string>;
  readonly slashCommands: ReadonlyArray<string>;
  /**
   * By plugin name, not source or path: account-synced plugins load locally as
   * "<name>@synced" and in the sandbox from a local marketplace.
   */
  readonly plugins: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly tools: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<string>;
  readonly permissionMode: string;
  readonly model: string;
  readonly claudeVersion: string;
}

const CLAUDE_ARGS = ["-p", "ok", "--output-format", "stream-json", "--verbose"];
const INIT_TIMEOUT_MS = 90_000;

const isInitLine = (line: string) => line.includes('"subtype":"init"');

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const parseInitLine = (line: string): ClaudeInit => {
  const raw = JSON.parse(line) as Record<string, unknown>;
  if (raw.type !== "system" || raw.subtype !== "init") {
    throw new Error("Not a claude init message");
  }
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  const mcp = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  return {
    skills: strings(raw.skills),
    slashCommands: strings(raw.slash_commands),
    plugins: plugins.map((plugin: { source?: string; name?: string }) =>
      String(plugin.name ?? plugin.source),
    ),
    mcpServers: mcp.map((server: { name?: string; status?: string }) => ({
      name: String(server.name),
      status: String(server.status ?? "unknown"),
    })),
    tools: strings(raw.tools),
    agents: strings(raw.agents),
    permissionMode: String(raw.permissionMode ?? ""),
    model: String(raw.model ?? ""),
    claudeVersion: String(raw.claude_code_version ?? ""),
  };
};

/**
 * A parent Claude or BusyBoy session leaks CLAUDE_CODE_* and similar vars
 * (entrypoint, permission mode) into children; keep only the basics.
 */
const KEPT_ENV = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];

export const cleanLocalEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const clean: Record<string, string> = {};
  for (const key of KEPT_ENV) {
    const value = env[key];
    if (value !== undefined) clean[key] = value;
  }
  return clean;
};

export const captureLocalInit = async (host: LocalHost, cwd: string): Promise<ClaudeInit> =>
  parseInitLine(
    await host.firstMatchingLine({
      cmd: "claude",
      args: CLAUDE_ARGS,
      cwd,
      env: cleanLocalEnv(host.env),
      match: isInitLine,
      timeoutMs: INIT_TIMEOUT_MS,
    }),
  );

export const captureRemoteInit = async (
  sandbox: SandboxHandle,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<ClaudeInit> => {
  const output = await sandbox.sh(
    `cd ${shellQuote(cwd)} && claude ${CLAUDE_ARGS.map(shellQuote).join(" ")} | grep -m1 '"subtype":"init"'`,
    { env: { IS_SANDBOX: "1", ...env }, timeoutMs: INIT_TIMEOUT_MS },
  );
  return parseInitLine(output.trim());
};

export type ParityCategory =
  | "skills"
  | "slashCommands"
  | "plugins"
  | "mcpServers"
  | "tools"
  | "agents"
  | "permissionMode"
  | "model"
  | "claudeVersion"
  | "settingsHash";

export interface ParityItem {
  readonly name: string;
  readonly expected?: LocalOnlyMatch;
}

export interface CategoryResult {
  readonly category: ParityCategory;
  readonly same: boolean;
  readonly onlyLocal: ReadonlyArray<ParityItem>;
  readonly onlyRemote: ReadonlyArray<ParityItem>;
  /** Every difference is expected. */
  readonly ok: boolean;
  readonly localCount: number;
  readonly remoteCount: number;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly categories: ReadonlyArray<CategoryResult>;
  /** MCP servers on both sides whose connection status differs (informational). */
  readonly mcpStatusChanges: ReadonlyArray<{
    readonly name: string;
    readonly local: string;
    readonly remote: string;
  }>;
}

export interface ParitySide {
  readonly init: ClaudeInit;
  readonly settingsHash: string;
}

/** Server configs from the local ~/.claude.json, so stdio servers can be classified by command. */
export type McpConfigLookup = (name: string) => Parameters<typeof classifyMcpServer>[1];

const MCP_TOOL = /^mcp__(.+?)__/;

/** The local-only server behind an MCP tool or prompt name (mcp__<server>__...). */
const mcpServerMatch = (name: string, mcpConfig: McpConfigLookup): LocalOnlyMatch | undefined => {
  const server = name.match(MCP_TOOL)?.[1];
  if (server === undefined) return undefined;
  // Tool names flatten "claude.ai Gmail" to "claude_ai_Gmail".
  const candidates = [server, server.replace(/^claude_ai_/, "claude.ai ").replace(/_/g, " ")];
  for (const candidate of candidates) {
    const match = classifyMcpServer(candidate, mcpConfig(candidate));
    if (match !== null) return match;
  }
  return undefined;
};

const expectedFor = (
  side: "local" | "remote",
  category: ParityCategory,
  name: string,
  mcpConfig: McpConfigLookup,
): LocalOnlyMatch | undefined => {
  const account = classifyAccountFeature(side, category, name);
  if (account !== null) return account;
  if (side === "remote") return undefined;
  if (category === "mcpServers") return classifyMcpServer(name, mcpConfig(name)) ?? undefined;
  if (category === "tools") return classifyTool(name) ?? mcpServerMatch(name, mcpConfig);
  if (category === "slashCommands") return mcpServerMatch(name, mcpConfig);
  return undefined;
};

const compareList = (
  category: ParityCategory,
  local: ReadonlyArray<string>,
  remote: ReadonlyArray<string>,
  mcpConfig: McpConfigLookup,
): CategoryResult => {
  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const only = (side: "local" | "remote", from: Set<string>, other: Set<string>) =>
    [...from]
      .filter((name) => !other.has(name))
      .sort()
      .map((name): ParityItem => {
        const expected = expectedFor(side, category, name, mcpConfig);
        return expected === undefined ? { name } : { name, expected };
      });
  const onlyLocal = only("local", localSet, remoteSet);
  const onlyRemote = only("remote", remoteSet, localSet);
  return {
    category,
    same: onlyLocal.length === 0 && onlyRemote.length === 0,
    onlyLocal,
    onlyRemote,
    ok: [...onlyLocal, ...onlyRemote].every((item) => item.expected !== undefined),
    localCount: localSet.size,
    remoteCount: remoteSet.size,
  };
};

/**
 * Several plugins can declare the same connector (slack, notion, ...); claude
 * keeps one, and which plugin "owns" it depends on load order. Compare plugin
 * servers by connector name.
 */
export const mcpIdentity = (name: string) => name.replace(/^plugin:[^:]+:/, "plugin:*:");

const UNCONNECTED_PLUGIN_SERVER: LocalOnlyMatch = {
  kind: "claude-ai-account",
  reason:
    "샌드박스에만 보이는 플러그인 MCP예요. 아직 연결되지 않아 도구가 없어서 동작 차이는 없어요. 로컬은 claude.ai 계정 커넥터와 겹치는 플러그인 MCP를 숨기는 것으로 보여요.",
};

const compareMcpServers = (
  local: ClaudeInit["mcpServers"],
  remote: ClaudeInit["mcpServers"],
  mcpConfig: McpConfigLookup,
): CategoryResult => {
  const base = compareList(
    "mcpServers",
    local.map((server) => mcpIdentity(server.name)),
    remote.map((server) => mcpIdentity(server.name)),
    (name) => mcpConfig(name),
  );
  const remoteStatus = new Map(remote.map((server) => [mcpIdentity(server.name), server.status]));
  const onlyRemote = base.onlyRemote.map((item): ParityItem =>
    item.expected === undefined &&
    item.name.startsWith("plugin:") &&
    remoteStatus.get(item.name) !== "connected"
      ? { name: item.name, expected: UNCONNECTED_PLUGIN_SERVER }
      : item,
  );
  return {
    ...base,
    onlyRemote,
    ok: [...base.onlyLocal, ...onlyRemote].every((item) => item.expected !== undefined),
  };
};

const compareValue = (category: ParityCategory, local: string, remote: string): CategoryResult => {
  const same = local === remote;
  return {
    category,
    same,
    onlyLocal: same ? [] : [{ name: local }],
    onlyRemote: same ? [] : [{ name: remote }],
    ok: same,
    localCount: 1,
    remoteCount: 1,
  };
};

export const compareInit = (
  local: ParitySide,
  remote: ParitySide,
  mcpConfig: McpConfigLookup = () => undefined,
): ParityResult => {
  const categories: CategoryResult[] = [
    compareList("skills", local.init.skills, remote.init.skills, mcpConfig),
    compareList("slashCommands", local.init.slashCommands, remote.init.slashCommands, mcpConfig),
    compareList("plugins", local.init.plugins, remote.init.plugins, mcpConfig),
    compareMcpServers(local.init.mcpServers, remote.init.mcpServers, mcpConfig),
    compareList("tools", local.init.tools, remote.init.tools, mcpConfig),
    compareList("agents", local.init.agents, remote.init.agents, mcpConfig),
    compareValue("permissionMode", local.init.permissionMode, remote.init.permissionMode),
    compareValue("model", local.init.model, remote.init.model),
    compareValue("claudeVersion", local.init.claudeVersion, remote.init.claudeVersion),
    compareValue("settingsHash", local.settingsHash, remote.settingsHash),
  ];
  const remoteStatus = new Map(
    remote.init.mcpServers.map((server) => [mcpIdentity(server.name), server.status]),
  );
  const mcpStatusChanges = local.init.mcpServers.flatMap((server) => {
    const other = remoteStatus.get(mcpIdentity(server.name));
    return other === undefined || other === server.status
      ? []
      : [{ name: server.name, local: server.status, remote: other }];
  });
  return { ok: categories.every((category) => category.ok), categories, mcpStatusChanges };
};

const LABELS: Record<ParityCategory, string> = {
  skills: "스킬",
  slashCommands: "슬래시 명령",
  plugins: "플러그인",
  mcpServers: "MCP 서버",
  tools: "도구",
  agents: "에이전트",
  permissionMode: "권한 모드",
  model: "모델",
  claudeVersion: "claude 버전",
  settingsHash: "설정 해시",
};

/** A short Korean summary, one line per category, for logs and task notes. */
export const renderParitySummary = (result: ParityResult): string =>
  [
    result.ok
      ? "점검 통과: 예상된 차이 말고는 로컬과 같아요."
      : "점검 실패: 예상하지 못한 차이가 있어요.",
    ...result.categories.map((category) => {
      if (category.same) return `- ${LABELS[category.category]}: 같음 (${category.localCount})`;
      const describe = (items: ReadonlyArray<ParityItem>) =>
        items.map((item) => (item.expected ? `${item.name}(예상된 차이)` : item.name)).join(", ");
      const parts = [
        category.onlyLocal.length > 0 ? `로컬에만: ${describe(category.onlyLocal)}` : null,
        category.onlyRemote.length > 0 ? `샌드박스에만: ${describe(category.onlyRemote)}` : null,
      ].filter((part) => part !== null);
      return `- ${LABELS[category.category]}: ${category.ok ? "예상된 차이만" : "다름"} — ${parts.join(" / ")}`;
    }),
  ].join("\n");
