import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderId } from "./runner/contract";
import { agentEnvironment, findExecutable } from "./runner/find-executable";

// BusyBoy does not keep connector tokens. The harness config is the list, and login is the harness CLI.

export type ConnectorStatus = "connected" | "needs-login" | "failed";

export type ConnectorServer = {
  name: string;
  status: ConnectorStatus;
  detail?: string;
  loginCommand?: string;
};

export type ConnectorOffer = { name: string; title: string; url: string; command: string };

type ConnectorProvider = "claude" | "codex";

export type ConnectorHarness = {
  provider: ConnectorProvider;
  name: string;
  servers: ConnectorServer[];
  add: ConnectorOffer[];
};

const OFFICIAL = [
  { name: "slack", title: "Slack", url: "https://mcp.slack.com/mcp" },
  { name: "linear", title: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "notion", title: "Notion", url: "https://mcp.notion.com/mcp" },
] as const;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const PROBE_MS = 3_000;
const ADD_TIMEOUT_MS = 20_000;

type Listed = {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export function addCommand(provider: ProviderId, name: string, url: string) {
  return provider === "claude"
    ? `claude mcp add --transport http --scope user ${name} ${url}`
    : `codex mcp add ${name} --url ${url}`;
}

export function loginCommand(provider: ProviderId, name: string) {
  return provider === "claude" ? `claude mcp login ${name}` : `codex mcp login ${name}`;
}

export function officialConnector(name: string) {
  return OFFICIAL.find((server) => server.name === name);
}

function configDir(envName: string, fallback: string) {
  return process.env[envName] || join(homedir(), fallback);
}

function claudeConfigDir() {
  return configDir("CLAUDE_CONFIG_DIR", ".claude");
}

function codexConfigDir() {
  return configDir("CODEX_HOME", ".codex");
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function asServers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

function listedFrom(name: string, value: unknown): Listed | undefined {
  if (!SERVER_NAME.test(name) || !value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const server = value as {
    type?: unknown;
    url?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    headers?: unknown;
  };
  const strings = (record: unknown) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
    const entries = Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const url = typeof server.url === "string" ? server.url : undefined;
  const command = typeof server.command === "string" ? server.command : undefined;
  const args =
    Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")
      ? server.args
      : undefined;
  if (!url && !command) return undefined;
  return { name, url, command, args, env: strings(server.env), headers: strings(server.headers) };
}

async function claudeServers(): Promise<Listed[]> {
  const dir = claudeConfigDir();
  const files = [join(dir, ".claude.json"), join(dir, "settings.json")];
  if (!process.env.CLAUDE_CONFIG_DIR) files.unshift(join(homedir(), ".claude.json"));
  const byName = new Map<string, Listed>();
  for (const file of files) {
    for (const [name, value] of Object.entries(asServers(await readJson(file)))) {
      const server = listedFrom(name, value);
      if (server && !byName.has(name)) byName.set(name, server);
    }
  }
  return [...byName.values()];
}

function tomlString(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return undefined;
}

async function codexServers(): Promise<Listed[]> {
  let text = "";
  try {
    text = await readFile(join(codexConfigDir(), "config.toml"), "utf8");
  } catch {
    return [];
  }
  const servers = new Map<string, Listed & { enabled: boolean }>();
  let current: (Listed & { enabled: boolean }) | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const table = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/.exec(line);
      current = undefined;
      if (!table) continue;
      current = servers.get(table[1]) ?? { name: table[1], enabled: true };
      servers.set(table[1], current);
      continue;
    }
    if (!current || !line || line.startsWith("#")) continue;
    const field = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (key === "enabled") current.enabled = !/^false\b/.test(rawValue.trim());
    else if (key === "url") current.url = tomlString(rawValue);
    else if (key === "command") current.command = tomlString(rawValue);
    else if (key === "args" && rawValue.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(rawValue.trim()) as unknown;
        if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string"))
          current.args = parsed;
      } catch {
        // A value this parser cannot read is left out; the server is still listed from its command or url.
      }
    }
  }
  return [...servers.values()].filter((server) => server.enabled && (server.url || server.command));
}

function httpUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function probeHttp(server: Listed): Promise<Pick<ConnectorServer, "status" | "detail">> {
  const url = httpUrl(server.url);
  if (!url) return { status: "failed", detail: "The server URL is not an HTTP address." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...server.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "busyboy", version: "0.0.0" },
        },
      }),
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403) return { status: "needs-login" };
    const body = await response.text();
    if (response.status >= 300 && response.status < 400) return { status: "needs-login" };
    if (!response.ok)
      return { status: "failed", detail: `The server returned HTTP ${response.status}.` };
    if (/"result"\s*:/.test(body) || /protocolVersion/.test(body)) return { status: "connected" };
    if (/unauthorized|login|sign in|oauth/i.test(body)) return { status: "needs-login" };
    return { status: "failed", detail: "The server did not accept an MCP initialize." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      detail: /abort/i.test(message)
        ? "The server did not answer in time."
        : "The server could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeStdio(server: Listed): Promise<Pick<ConnectorServer, "status" | "detail">> {
  if (!server.command) return { status: "failed", detail: "The server has no command." };
  const command =
    server.command.includes("/") || server.command.includes("\\")
      ? server.command
      : findExecutable(server.command);
  if (!command) return { status: "failed", detail: `The command ${server.command} was not found.` };
  return new Promise((resolve) => {
    let settled = false;
    const child = execFile(
      command,
      server.args ?? [],
      { env: { ...agentEnvironment(), ...server.env } as NodeJS.ProcessEnv, timeout: PROBE_MS },
      () => {},
    );
    const finish = (result: Pick<ConnectorServer, "status" | "detail">) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(result);
    };
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (/"result"\s*:/.test(output) || /protocolVersion/.test(output))
        finish({ status: "connected" });
    });
    child.on("error", () =>
      finish({ status: "failed", detail: `The command ${server.command} could not start.` }),
    );
    child.on("exit", (code) => {
      if (code && code !== 0)
        finish({ status: "failed", detail: `The command exited with code ${code}.` });
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "busyboy", version: "0.0.0" },
      },
    });
    // Closing stdin ends an MCP stdio handshake before the server answers.
    child.stdin?.on("error", () => {});
    child.stdin?.write(`${body}\n`);
    setTimeout(
      () => finish({ status: "failed", detail: "The server did not answer in time." }),
      PROBE_MS,
    ).unref();
  });
}

async function probe(provider: ProviderId, server: Listed): Promise<ConnectorServer> {
  const result = server.url ? await probeHttp(server) : await probeStdio(server);
  return {
    name: server.name,
    ...result,
    ...(result.status === "needs-login"
      ? { loginCommand: loginCommand(provider, server.name) }
      : {}),
  };
}

function offers(provider: ProviderId, present: Set<string>): ConnectorOffer[] {
  return OFFICIAL.filter((server) => !present.has(server.name)).map((server) => ({
    ...server,
    command: addCommand(provider, server.name, server.url),
  }));
}

export async function listConnectors(): Promise<ConnectorHarness[]> {
  const [claude, codex] = await Promise.all([claudeServers(), codexServers()]);
  const harnesses: { provider: ConnectorProvider; name: string; listed: Listed[] }[] = [
    { provider: "claude", name: "Claude Code", listed: claude },
    { provider: "codex", name: "Codex", listed: codex },
  ];
  return Promise.all(
    harnesses.map(async ({ provider, name, listed }) => {
      const servers = await Promise.all(
        listed.slice(0, 20).map((server) => probe(provider, server)),
      );
      servers.sort((a, b) => a.name.localeCompare(b.name));
      return {
        provider,
        name,
        servers,
        add: offers(provider, new Set(listed.map((server) => server.name))),
      };
    }),
  );
}

export async function addConnector(provider: ProviderId, name: string) {
  const server = officialConnector(name);
  if (!server || (provider !== "claude" && provider !== "codex"))
    throw new Error("Unknown connector.");
  const executable =
    (provider === "claude" ? process.env.BUSYBOY_CLAUDE_PATH : process.env.BUSYBOY_CODEX_PATH) ||
    findExecutable(provider);
  if (!executable)
    throw new Error(
      `The \`${provider}\` command was not found. Run ${addCommand(provider, server.name, server.url)} in a terminal.`,
    );
  const args =
    provider === "claude"
      ? ["mcp", "add", "--transport", "http", "--scope", "user", server.name, server.url]
      : ["mcp", "add", server.name, "--url", server.url];
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      args,
      { env: agentEnvironment() as NodeJS.ProcessEnv, timeout: ADD_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim().split("\n").at(-1);
        const timedOut = "killed" in error && error.killed;
        reject(
          new Error(
            timedOut
              ? `${server.title} was asked to sign in, and the command is still waiting. Run ${loginCommand(provider, server.name)} in a terminal.`
              : detail || error.message,
          ),
        );
      },
    );
  });
}
