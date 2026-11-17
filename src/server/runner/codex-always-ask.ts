import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ALWAYS_ASK_PATH,
  alwaysAskTokenFor,
  MCP_TOKEN_HEADER,
  SERVER_TOKEN_ENV,
} from "@/lib/server-token";

import { alwaysAskRules } from "../always-ask-list";
import { resolveDataFolder } from "../config";
import { containsPath } from "../paths";
import { listProjects } from "../projects";
import { matchAlwaysAsk } from "./always-ask";
import { checkUserRules, resolveRulesFolder } from "./user-rules";

// Codex's auto reviewer approves escalations without the user. Verified with codex-cli 0.167.0: a hook denial blocks the command.

export type HookCall = {
  sessionId: string | undefined;
  cwd: string | undefined;
  toolName: string;
  input: unknown;
};

export type HookDecision = { allow: boolean; reason: string };

type Gate = (
  call: Pick<HookCall, "toolName" | "input" | "cwd"> & { signal: AbortSignal },
) => Promise<HookDecision>;

// On globalThis like the runner's registry, so `next dev` reloads keep the open sessions.
const GATES_KEY = Symbol.for("busyboy.codex-always-ask");
const globalStore = globalThis as typeof globalThis & { [GATES_KEY]?: Map<string, Gate> };
const gates = (globalStore[GATES_KEY] ??= new Map());

export function registerGate({ key, gate }: { key: string; gate: Gate }) {
  gates.set(key, gate);
  return () => {
    if (gates.get(key) === gate) {
      gates.delete(key);
    }
  };
}

export const threadKey = (threadId: string) => `thread:${threadId}`;
export const folderKey = (cwd: string) => `cwd:${cwd}`;

// Codex also runs its own agents, such as memory consolidation in ~/.codex/memories, with the thread's hooks. Those are not ours to ask about.
export function decideHookCall({
  call,
  signal,
}: {
  call: HookCall;
  signal: AbortSignal;
}): Promise<HookDecision> {
  const byThread = call.sessionId ? gates.get(threadKey(call.sessionId)) : undefined;
  const byFolder = call.cwd
    ? [...gates.entries()].find(
        ([key]) =>
          key.startsWith("cwd:") && isInside({ folder: key.slice("cwd:".length), path: call.cwd! }),
      )?.[1]
    : undefined;
  const gate = byThread ?? byFolder;
  if (!gate) {
    return decideUnowned(call);
  }
  return gate({ toolName: call.toolName, input: call.input, cwd: call.cwd, signal });
}

async function decideUnowned(call: HookCall): Promise<HookDecision> {
  const userRule = await checkUserRules({
    rulesFolder: resolveRulesFolder(undefined),
    toolName: call.toolName,
    input: call.input,
    cwd: call.cwd ?? "",
  });
  if (userRule.ask) return { allow: false, reason: userRule.detail };
  const cwd = call.cwd;
  if (!cwd) return { allow: true, reason: "" };
  const folders = [resolveDataFolder(), ...(await listProjects()).map(({ path }) => path)];
  if (!folders.some((folder) => isInside({ folder, path: cwd })))
    return { allow: true, reason: "" };
  const rule = matchAlwaysAsk({
    rules: await alwaysAskRules(),
    toolName: call.toolName,
    input: call.input,
    folder: cwd,
  });
  if (!rule) return { allow: true, reason: "" };
  return {
    allow: false,
    reason: `${rule}. BusyBoy did not start this agent, so it cannot ask the user, and blocked the action.`,
  };
}

function isInside({ folder, path }: { folder: string; path: string }) {
  return containsPath(folder, path);
}

// A script file on disk could be rewritten by any agent running as the user. Only the token is read from a file.
const hookScript = ({
  url,
  tokenFile,
}: {
  url: string;
  tokenFile: string;
}) => `import { readFileSync } from 'node:fs'
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  process.exit(0)
}
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
  const token = readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim()
  const headers = { 'content-type': 'application/json', ...(token ? { ${JSON.stringify(MCP_TOKEN_HEADER)}: token } : {}) }
  const response = await fetch(${JSON.stringify(url)}, { method: 'POST', headers, body: input })
  const result = JSON.parse((await response.text()).trim())
  if (!response.ok || result.allow !== true) deny(result.reason || 'The user did not allow this action.')
} catch (error) {
  deny('BusyBoy could not ask the user: ' + (error instanceof Error ? error.message : String(error)))
}
`;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const CANNOT_RUN = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "BusyBoy could not ask the user: its always-ask hook could not run.",
  },
});

// The command is the same for every thread, so Codex's trust hash for it stays the same.
export async function hookCommand() {
  const port = process.env.PORT ?? "3000";
  const folder = join(resolveDataFolder(), `always-ask-${port}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const token = process.env[SERVER_TOKEN_ENV];
  const tokenFile = join(folder, "token");
  await writeFile(tokenFile, token ? alwaysAskTokenFor(token) : "", { mode: 0o600 });
  const script = hookScript({ url: `http://127.0.0.1:${port}${ALWAYS_ASK_PATH}`, tokenFile });
  return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} --input-type=module -e ${quote(script)} || printf '%s' ${quote(CANNOT_RUN)}`;
}

const HOOK_TIMEOUT_S = 24 * 60 * 60;

type Request = <T>(method: string, params: unknown) => Promise<T>;

type ListedHook = {
  key: string;
  command?: string;
  source?: string;
  currentHash: string;
  trustStatus?: string;
};

const trust = new Map<string, Promise<{ key: string; hash: string }>>();

// Codex trusts hooks by a hash it does not document. Verified with codex-cli 0.167.0.
export async function trustedHookConfig({
  request,
  cwd,
  executable,
}: {
  request: Request;
  cwd: string;
  executable: string;
}) {
  const hookCommandText = await hookCommand();
  const hooks = {
    PreToolUse: [
      {
        matcher: null,
        hooks: [{ type: "command", command: hookCommandText, timeout: HOOK_TIMEOUT_S }],
      },
    ],
  };
  const cacheKey = `${executable}\n${hookCommandText}`;
  let trusted = trust.get(cacheKey);
  if (!trusted) {
    trusted = (async () => {
      const probe = await request<{ thread: { id: string } }>("thread/start", {
        cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { hooks },
      });
      const { data } = await request<{ data: { hooks: ListedHook[] }[] }>("hooks/list", {
        threadId: probe.thread.id,
      });
      const listed = data
        .flatMap((entry) => entry.hooks)
        .find((hook) => hook.source === "sessionFlags" && hook.command === hookCommandText);
      if (!listed) {
        throw new Error(
          "Codex did not load the always-ask hook, so it cannot ask before irreversible actions.",
        );
      }
      return { key: listed.key, hash: listed.currentHash };
    })();
    trust.set(cacheKey, trusted);
    trusted.catch(() => trust.delete(cacheKey));
  }
  const { key, hash } = await trusted;
  return {
    config: { hooks: { ...hooks, state: { [key]: { trusted_hash: hash } } } },
    // An untrusted hook is skipped with no error, which would let every rule through.
    verify: async (threadId: string) => {
      const { data } = await request<{ data: { hooks: ListedHook[] }[] }>("hooks/list", {
        threadId,
      });
      const listed = data
        .flatMap((entry) => entry.hooks)
        .find((hook) => hook.command === hookCommandText);
      if (listed?.trustStatus !== "trusted") {
        trust.delete(cacheKey);
        throw new Error(
          "Codex did not trust the always-ask hook, so it cannot ask before irreversible actions. Try again.",
        );
      }
    },
  };
}
