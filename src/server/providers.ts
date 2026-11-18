import { readSettings, updateSettings } from "./config";
import { providerSignInStatus } from "./runner/agent-runner";
import type { ProviderId, SignInStatus } from "./runner/contract";

export const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "grok", name: "Grok" },
];

const CACHE_MS = 30_000;

type CacheEntry = { at: number; state: Promise<SignInStatus> };
const CACHE_KEY = Symbol.for("busyboy.provider-states");
const globalStore = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<ProviderId, CacheEntry> };
const cache = (globalStore[CACHE_KEY] ??= new Map());

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
