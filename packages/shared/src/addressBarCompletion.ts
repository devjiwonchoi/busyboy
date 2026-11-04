/** Inline completion needs at least this many typed characters. */
export const INLINE_COMPLETION_MIN_LENGTH = 2;
/** An origin is offered on its own once it has been visited this often. */
export const INLINE_COMPLETION_ORIGIN_MIN_VISITS = 2;

export interface InlineCompletionCandidate {
  /** The top history match. */
  readonly url: string;
  /** That match's origin root (`https://github.com/`) and how often it was visited itself. */
  readonly origin: { readonly url: string; readonly visitCount: number } | null;
}

export interface InlineCompletion {
  /** Where Enter goes when the completion is shown. */
  readonly url: string;
  /** Text inserted after the caret, shown selected. */
  readonly suffix: string;
}

/** The part people type: no scheme, no leading `www.`. */
export function stripForCompletion(value: string): string {
  return value.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").replace(/^www\./i, "");
}

/**
 * The inline completion for what the user typed, or null. Only history
 * matches complete inline, never search text, and only while the caret is at
 * the end of the input.
 */
export function inlineCompletionFor(
  typed: string,
  candidate: InlineCompletionCandidate | null,
  options: { readonly caretAtEnd: boolean },
): InlineCompletion | null {
  if (candidate === null || !options.caretAtEnd) return null;
  if (typed.length < INLINE_COMPLETION_MIN_LENGTH || /\s/.test(typed)) return null;
  const typedStripped = stripForCompletion(typed).toLowerCase();
  if (typedStripped.length === 0) return null;
  const targets =
    candidate.origin !== null && candidate.origin.visitCount >= INLINE_COMPLETION_ORIGIN_MIN_VISITS
      ? [candidate.origin.url, candidate.url]
      : [candidate.url];
  for (const url of targets) {
    const stripped = stripForCompletion(url);
    if (
      stripped.length > typedStripped.length &&
      stripped.toLowerCase().startsWith(typedStripped)
    ) {
      return { url, suffix: stripped.slice(typedStripped.length) };
    }
  }
  return null;
}
