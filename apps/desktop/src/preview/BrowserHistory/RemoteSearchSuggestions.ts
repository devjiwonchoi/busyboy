// @effect-diagnostics globalTimers:off - A plain debounce/timeout class; tests inject their own timers.
import { ADDRESS_BAR_REMOTE_SUGGESTIONS_MAX } from "@t3tools/contracts";
import { type AddressBarSearchEngine } from "@t3tools/shared/preview";

export const REMOTE_SUGGESTIONS_DEBOUNCE_MS = 150;
export const REMOTE_SUGGESTIONS_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_CHARS = 64 * 1024;
const MAX_SUGGESTION_LENGTH = 256;

/** `user:pass@host`, with or without a scheme: never sent anywhere. */
const CREDENTIALS_PATTERN = /^(?:[a-z][a-z\d+.-]*:\/\/)?[^\s/@]*:[^\s/@]*@/i;

export interface RemoteSuggestionGate {
  readonly enabled: boolean;
  readonly incognito: boolean;
  readonly engine: AddressBarSearchEngine;
  readonly input: string;
  /** Re-read right before sending, so turning the setting off stops a debounced request. */
  readonly stillEnabled?: (() => boolean) | undefined;
}

/** Whether typed text may leave the machine at all. */
export function mayRequestRemoteSuggestions(gate: RemoteSuggestionGate): boolean {
  const text = gate.input.trim();
  return (
    gate.enabled &&
    !gate.incognito &&
    gate.engine.suggestUrl !== null &&
    text.length > 0 &&
    !CREDENTIALS_PATTERN.test(text)
  );
}

/** OpenSearch suggestions: `[query, [suggestion, …], …]`. Anything else yields nothing. */
export function parseOpenSearchSuggestions(body: string): string[] {
  if (body.length > MAX_RESPONSE_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) && Array.isArray(parsed[1]) ? (parsed[1] as unknown[]) : [];
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_SUGGESTION_LENGTH);
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    suggestions.push(text);
    if (suggestions.length === ADDRESS_BAR_REMOTE_SUGGESTIONS_MAX) break;
  }
  return suggestions;
}

export type SuggestionFetch = (url: string, signal: AbortSignal) => Promise<string>;

export interface RemoteSuggestionClientOptions {
  readonly fetch: SuggestionFetch;
  readonly debounceMs?: number;
  readonly timeoutMs?: number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/**
 * One in-flight suggestion request at a time. A new request waits out the
 * debounce, and any newer request cancels the older one (which resolves
 * empty), as does the timeout.
 */
export class RemoteSuggestionClient {
  private readonly options: Required<RemoteSuggestionClientOptions>;
  private current: { readonly cancel: () => void } | null = null;

  constructor(options: RemoteSuggestionClientOptions) {
    this.options = {
      debounceMs: REMOTE_SUGGESTIONS_DEBOUNCE_MS,
      timeoutMs: REMOTE_SUGGESTIONS_TIMEOUT_MS,
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  /** Cancels whatever is pending without starting anything new. */
  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }

  request(gate: RemoteSuggestionGate): Promise<string[]> {
    this.cancel();
    if (!mayRequestRemoteSuggestions(gate)) return Promise.resolve([]);
    const url = gate.engine.suggestUrl!.replace("%s", encodeURIComponent(gate.input.trim()));
    const { debounceMs, timeoutMs, setTimeout, clearTimeout, fetch } = this.options;
    return new Promise<string[]>((resolve) => {
      const controller = new AbortController();
      let settled = false;
      let debounce: unknown = null;
      let timeout: unknown = null;
      const finish = (suggestions: string[]) => {
        if (settled) return;
        settled = true;
        if (debounce !== null) clearTimeout(debounce);
        if (timeout !== null) clearTimeout(timeout);
        if (this.current === handle) this.current = null;
        resolve(suggestions);
      };
      const handle = {
        cancel: () => {
          controller.abort();
          finish([]);
        },
      };
      this.current = handle;
      debounce = setTimeout(() => {
        debounce = null;
        if (gate.stillEnabled !== undefined && !gate.stillEnabled()) {
          finish([]);
          return;
        }
        timeout = setTimeout(handle.cancel, timeoutMs);
        fetch(url, controller.signal).then(
          (body) => finish(controller.signal.aborted ? [] : parseOpenSearchSuggestions(body)),
          () => finish([]),
        );
      }, debounceMs);
    });
  }
}
