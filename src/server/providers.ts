import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { isTestMode, readSettings, updateSettings } from "./config";
import { providerSignInStatus } from "./runner/agent-runner";
import type { ProviderId, SignInStatus } from "./runner/contract";

export const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "grok", name: "Grok" },
];

export const TEST_SIGN_IN_COOKIE = "busyboy-test-sign-in";

const LOGIN_COMMANDS: Record<ProviderId, string> = {
  claude: "claude /login",
  codex: "codex login",
  grok: "grok login",
};
const UPDATE_COMMANDS: Record<ProviderId, string> = {
  claude: "claude update",
  codex: "codex update",
  grok: "grok update",
};
const CACHE_MS = 30_000;

type CacheEntry = { at: number; state: Promise<SignInStatus> };
const CACHE_KEY = Symbol.for("busyboy.provider-states");
const globalStore = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<ProviderId, CacheEntry> };
const cache = (globalStore[CACHE_KEY] ??= new Map());

async function testOverride(provider: ProviderId): Promise<SignInStatus | undefined> {
  if (!isTestMode()) return undefined;
  let value: string | undefined;
  try {
    value = (await cookies()).get(TEST_SIGN_IN_COOKIE)?.value;
  } catch (error) {
    unstable_rethrow(error);
    return undefined;
  }
  const pair = value
    ?.split(",")
    .map((entry) => entry.split("="))
    .find(([id]) => id === provider);
  switch (pair?.[1]) {
    case "signed-in":
      return { state: "signed-in", account: "test" };
    case "signed-out":
      return { state: "signed-out", loginCommand: LOGIN_COMMANDS[provider] };
    case "not-installed":
      return { state: "not-installed", detail: "Not installed (test)." };
    case "outdated":
      return {
        state: "outdated",
        detail: "Too old (test).",
        updateCommand: UPDATE_COMMANDS[provider],
      };
  }
  return undefined;
}

async function probe(provider: ProviderId): Promise<SignInStatus> {
  try {
    return await providerSignInStatus(provider);
  } catch (error) {
    return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function providerState(
  provider: ProviderId,
  { fresh = false } = {},
): Promise<SignInStatus> {
  const override = await testOverride(provider);
  if (override) return override;
  const cached = cache.get(provider);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  const state = probe(provider);
  cache.set(provider, { at: Date.now(), state });
  return state;
}

export async function signedInProviders(): Promise<ProviderId[]> {
  const states = await Promise.all(
    PROVIDERS.map(async ({ id }) => [id, await providerState(id)] as const),
  );
  return states.filter(([, state]) => state.state === "signed-in").map(([id]) => id);
}

export async function defaultProvider(): Promise<ProviderId | null> {
  const signedIn = await signedInProviders();
  if (signedIn.length <= 1) return signedIn[0] ?? null;
  const stored = (await readSettings()).defaultProvider;
  return stored && signedIn.includes(stored) ? stored : signedIn[0];
}

export async function setDefaultProvider(provider: ProviderId) {
  await updateSettings((settings) => {
    settings.defaultProvider = provider;
  });
}

export const SKILLS_PLUGIN = "jwn";

export type SkillsState = { installed: boolean; installCommand: string };

const INSTALL_COMMANDS: Record<ProviderId, string> = {
  claude: "claude plugin marketplace add devjiwonchoi/skills && claude plugin install jwn@jwn",
  codex: "codex plugin marketplace add devjiwonchoi/skills && codex plugin add jwn@jwn",
  grok: "grok plugin marketplace add devjiwonchoi/skills && grok plugin add jwn@jwn",
};

async function readText(file: string) {
  return readFile(file, "utf8").catch(() => "");
}

async function claudeHasPlugin() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const data = JSON.parse(
      await readText(join(configDir, "plugins", "installed_plugins.json")),
    ) as {
      plugins?: Record<string, unknown[]>;
    };
    return Object.entries(data.plugins ?? {}).some(
      ([key, installs]) =>
        key.split("@")[0] === SKILLS_PLUGIN && Array.isArray(installs) && installs.length > 0,
    );
  } catch {
    return false;
  }
}

async function codexHasPlugin() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const lines = (await readText(join(codexHome, "config.toml"))).split("\n");
  let inTable = false;
  let found = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (inTable) return true;
      inTable = new RegExp(`^\\[plugins\\."${SKILLS_PLUGIN}@[^"]+"\\]$`).test(line);
      found ||= inTable;
      continue;
    }
    if (inTable && /^enabled\s*=\s*false\b/.test(line)) inTable = found = false;
  }
  return found;
}

async function grokHasPlugin() {
  const grokHome = process.env.GROK_HOME || join(homedir(), ".grok");
  const lines = (await readText(join(grokHome, "config.toml"))).split("\n");
  let inTable = false;
  let found = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (inTable) return true;
      inTable = new RegExp(`^\\[plugins\\."${SKILLS_PLUGIN}@[^"]+"\\]$`).test(line);
      found ||= inTable;
      continue;
    }
    if (inTable && /^enabled\s*=\s*false\b/.test(line)) inTable = found = false;
  }
  return found;
}

export async function skillsState(provider: ProviderId): Promise<SkillsState> {
  const installed =
    provider === "claude"
      ? await claudeHasPlugin()
      : provider === "codex"
        ? await codexHasPlugin()
        : await grokHasPlugin();
  return { installed, installCommand: INSTALL_COMMANDS[provider] };
}
