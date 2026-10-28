import type { PasswordImportSourceId } from "@t3tools/contracts";

export type ImportedPassword = {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
};

export type SavedPassword = ImportedPassword & {
  readonly source: PasswordImportSourceId;
  readonly savedAt: number;
};

export type PasswordReadResult = {
  readonly passwords: ReadonlyArray<ImportedPassword>;
  readonly skipped: number;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Reduces a saved login URL to the origin it belongs to. Anything that is not
 * a web login (Android app links, `ftp:`, unparsable text) has no origin, so
 * it is skipped rather than guessed at.
 */
export const passwordOrigin = (url: string): string | undefined => {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
};

/** Pages served over plain HTTP only get passwords on the loopback interface. */
export const isFillableOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))
    );
  } catch {
    return false;
  }
};

const withoutWww = (hostname: string) =>
  hostname.startsWith("www.") ? hostname.slice("www.".length) : hostname;

/**
 * Exact host match, treating `www.` as the same site. Subdomains deliberately
 * do not match: without the public suffix list, `github.io` would otherwise
 * match every site hosted under it.
 *
 * A login saved over HTTP may fill the HTTPS page of the same host, but never
 * the other way round.
 */
export const passwordMatchesOrigin = ({
  savedOrigin,
  pageOrigin,
}: {
  readonly savedOrigin: string;
  readonly pageOrigin: string;
}): boolean => {
  let saved: URL;
  let page: URL;
  try {
    saved = new URL(savedOrigin);
    page = new URL(pageOrigin);
  } catch {
    return false;
  }

  const schemeAllowed =
    saved.protocol === page.protocol || (saved.protocol === "http:" && page.protocol === "https:");
  if (!schemeAllowed) {
    return false;
  }

  // An http login carries over to https only on the default ports; a dev
  // server on http://localhost:3000 says nothing about another port.
  const portMatches =
    saved.protocol === page.protocol
      ? saved.port === page.port
      : saved.port === "" && page.port === "";
  if (!portMatches) {
    return false;
  }

  return withoutWww(saved.hostname) === withoutWww(page.hostname);
};
