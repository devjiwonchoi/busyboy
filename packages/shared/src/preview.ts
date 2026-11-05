import * as Schema from "effect/Schema";

const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

export function newPreviewTabId(): string {
  nextPreviewTabSequence += 1;
  return `${TAB_ID_PREFIX}${nextPreviewTabSequence.toString(36)}`;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === "[::1]") return true;
  return false;
}

export class PreviewUrlNormalizationError extends Schema.TaggedError<PreviewUrlNormalizationError>()(
  "PreviewUrlNormalizationError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const isPreviewUrlNormalizationError = Schema.is(PreviewUrlNormalizationError);

function previewUrlProtocol(rawUrl: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(rawUrl)?.[1]?.toLowerCase().concat(":");
}

export type AddressBarSearchEngineId = "duckduckgo" | "google" | "bing" | "brave" | "custom";

export interface AddressBarSearchEngine {
  readonly id: AddressBarSearchEngineId;
  readonly name: string;
  /** Search results page; `%s` is replaced by the encoded query. */
  readonly searchUrl: string;
  /** Public OpenSearch-style suggestion endpoint, if the engine has one. */
  readonly suggestUrl: string | null;
}

export const ADDRESS_BAR_SEARCH_ENGINES: Readonly<
  Record<Exclude<AddressBarSearchEngineId, "custom">, AddressBarSearchEngine>
> = {
  duckduckgo: {
    id: "duckduckgo",
    name: "DuckDuckGo",
    searchUrl: "https://duckduckgo.com/?q=%s",
    suggestUrl: "https://duckduckgo.com/ac/?q=%s&type=list",
  },
  google: {
    id: "google",
    name: "Google",
    searchUrl: "https://www.google.com/search?q=%s",
    suggestUrl: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
  },
  bing: {
    id: "bing",
    name: "Bing",
    searchUrl: "https://www.bing.com/search?q=%s",
    suggestUrl: "https://api.bing.com/osjson.aspx?query=%s",
  },
  brave: {
    id: "brave",
    name: "Brave",
    searchUrl: "https://search.brave.com/search?q=%s",
    suggestUrl: "https://search.brave.com/api/suggest?q=%s",
  },
};

export interface AddressBarSearchOptions {
  readonly engine?: AddressBarSearchEngineId | undefined;
  readonly customSearchUrl?: string | undefined;
}

/**
 * The engine in use. A custom engine needs an http(s) template containing
 * `%s`; anything else falls back to DuckDuckGo, today's default.
 */
export function resolveSearchEngine(options?: AddressBarSearchOptions): AddressBarSearchEngine {
  const engine = options?.engine ?? "duckduckgo";
  if (engine !== "custom") return ADDRESS_BAR_SEARCH_ENGINES[engine];
  const template = options?.customSearchUrl?.trim() ?? "";
  if (
    template.includes("%s") &&
    /^https?:\/\//i.test(template) &&
    URL.canParse(template.replace("%s", "q"))
  ) {
    let name = "your search engine";
    try {
      name = new URL(template.replace("%s", "q")).hostname.replace(/^www\./, "");
    } catch {}
    return { id: "custom", name, searchUrl: template, suggestUrl: null };
  }
  return ADDRESS_BAR_SEARCH_ENGINES.duckduckgo;
}

export function searchUrlFor(text: string, options?: AddressBarSearchOptions): string {
  return resolveSearchEngine(options).searchUrl.replace("%s", encodeURIComponent(text.trim()));
}
const ADDRESS_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT_PATTERN = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const KNOWN_NON_WEB_SCHEMES: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "mailto:",
  "sms:",
  "ssh:",
  "tel:",
  "view-source:",
  "ws:",
  "wss:",
]);

export type AddressBarInputKind =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "search"; readonly text: string };

export function resolveAddressBarInput(
  rawInput: string,
  searchOptions?: AddressBarSearchOptions,
): string {
  const target = classifyAddressBarInput(rawInput);
  return target.kind === "url" ? target.url : searchUrlFor(target.text, searchOptions);
}

/**
 * Whether the address bar navigates to the input as a URL or searches for it.
 * Throws for empty input and non-web schemes.
 */
export function classifyAddressBarInput(rawInput: string): AddressBarInputKind {
  const trimmed = rawInput.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.length === 0)
    return { kind: "url", url: normalizePreviewUrl(trimmed) };
  if (!/\s/.test(trimmed)) {
    // `mailto:x` or `data:...` is an explicit scheme; `example.com:8080` or
    // `devbox:8080` is a bare host and port. `normalizePreviewUrl` would read
    // `mailto:alice@example.com` as credentials on a bare host, so reject here.
    const protocol = previewUrlProtocol(trimmed);
    if (
      protocol !== undefined &&
      (KNOWN_NON_WEB_SCHEMES.has(protocol) || !BARE_HOST_PORT_PATTERN.test(trimmed))
    ) {
      if (protocol !== "http:" && protocol !== "https:") {
        throw new PreviewUrlNormalizationError({
          inputLength: rawInput.length,
          reason: "unsupported-protocol",
          protocol,
        });
      }
      return { kind: "url", url: normalizePreviewUrl(trimmed) };
    }
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
    const host = authority.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    const hasPort = host.length < authority.replace(/^[^@]*@/, "").length;
    if (hasPort || ADDRESS_HOST_PATTERN.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      try {
        return { kind: "url", url: normalizePreviewUrl(trimmed) };
      } catch {}
    }
  }
  return { kind: "search", text: trimmed };
}

export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${useHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "parse",
      protocol: previewUrlProtocol(candidate),
      cause,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "unsupported-protocol",
      protocol: parsed.protocol,
    });
  }
  return parsed.href;
}
