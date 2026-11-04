import { isLoopbackHost } from "@t3tools/shared/preview";

export interface LoginOrigin {
  /** `scheme://host[:port]` */
  readonly origin: string;
  /** Plain http to a host that is not this machine. */
  readonly insecure: boolean;
}

/**
 * Reduces a URL the user typed (or a page URL) to the origin logins are keyed
 * on. A bare host gets `https://`, like the address bar. Only web origins
 * qualify.
 */
export function normalizeLoginOrigin(raw: string): LoginOrigin | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname.length === 0) return null;
  return {
    origin: url.origin,
    insecure: url.protocol === "http:" && !isLoopbackHost(url.hostname),
  };
}

/** The site name used in prompts: host without `www.`. */
export function siteLabel(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, "");
  } catch {
    return origin;
  }
}
