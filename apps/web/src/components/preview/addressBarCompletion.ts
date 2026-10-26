/**
 * The text to complete inline after what the user typed: the rest of a
 * suggested host, like Chrome and Min. Only a host that starts with the typed
 * text (with or without `www.`) completes; anything else would replace what
 * the user is typing. Text with a `.` or `:` may already be the whole host
 * (`github.com` must not become `github.com.evil.io` on Enter), so it is left
 * alone.
 */
export const inlineHostCompletion = ({
  typed,
  url,
}: {
  readonly typed: string;
  readonly url: string;
}): string | null => {
  const prefix = typed.toLowerCase();
  if (prefix === "" || /[\s/?#:]/.test(prefix) || prefix.replace(/^www\./, "").includes(".")) {
    return null;
  }

  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }

  for (const candidate of [host, host.replace(/^www\./, "")]) {
    if (candidate.startsWith(prefix) && candidate.length > prefix.length) {
      return candidate.slice(prefix.length);
    }
  }
  return null;
};
