import {
  BROWSER_HISTORY_MAX_TITLE_LENGTH,
  BROWSER_HISTORY_MAX_URL_LENGTH,
} from "@t3tools/contracts";

/**
 * Only web pages are history. `about:`, `data:`, `blob:`, `chrome:`,
 * `devtools:`, `view-source:`, `javascript:` and `file:` pages are not, and
 * loopback hosts stay in because dev servers are the main thing people open.
 */
const RECORDED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Strips credentials and the fragment. Returns null for anything that is not recorded. */
export function normalizeHistoryUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!RECORDED_PROTOCOLS.has(parsed.protocol)) return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  const href = parsed.href;
  return href.length > BROWSER_HISTORY_MAX_URL_LENGTH ? null : href;
}

export function normalizeHistoryTitle(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);
}

/** True when two URLs differ only by their fragment, which is not a new visit. */
export function isFragmentOnlyChange(previous: string, next: string): boolean {
  try {
    const a = new URL(previous);
    const b = new URL(next);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}
