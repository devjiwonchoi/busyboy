/**
 * Next-prompt suggestions for Codex threads. Codex has no built-in
 * suggestion yet (`thread/prediction/request` is declared but unimplemented),
 * so the adapter asks an ephemeral prediction fork of the finished turn, which
 * reuses the parent's prompt cache.
 */

/** The first Codex release whose `thread/fork` accepts `experimentalPredictionMode`. */
const PREDICTION_FORK_MIN_VERSION = [0, 163, 0] as const;

export const CODEX_PROMPT_SUGGESTION_INSTRUCTIONS = `Stop working on the task. Instead, predict the one message the user is most likely to send next, written the way they would write it.

Base it on what the user has asked for so far. It should read like something they were about to type themselves, not advice from you. Good predictions are short, concrete next steps: "run the tests" after a fix, "commit it" when the work is done, the option the user would pick when you offered choices, or "yes" when you asked whether to continue.

Reply with nothing if the next step is unclear, if the last turn failed or misunderstood the user, or if the prediction would involve credentials, security incidents, private data, or anything else sensitive. Never predict thanks or praise, a question, an idea the user did not raise, or text in your own voice.

Match the user's language and tone. Use 2 to 12 words on one line, with no quotes and no explanation. Do not use any tools.`;

/**
 * Reads the Codex version from an `initialize` user agent such as
 * `BusyBoy/0.164.0 (Mac OS 26.5.2; arm64) ...`.
 */
export function codexSupportsPredictionFork(userAgent: string): boolean {
  const match = /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent);
  if (match === null) {
    return false;
  }

  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, minimum] of PREDICTION_FORK_MIN_VERSION.entries()) {
    if (version[index]! !== minimum) {
      return version[index]! > minimum;
    }
  }

  return true;
}

const ASSISTANT_VOICE =
  /^(i'll|i will|i'm|i am|i can|let me|here's|here is|sure\b|of course|certainly)/i;
const META_REPLY =
  /^(none\b|nothing\b|no (suggestion|prediction)s?\b|n\/a\b|silence\b|\(.*\)$|\[.*\]$)/i;
const PRAISE = /\b(thanks|thank you|looks good|sounds good|great|perfect|awesome|nice)\b/i;
// Latin sentences need a space after the stop, so "file.ts" stays one sentence.
const MULTIPLE_SENTENCES = /[.!?]\s+\S|[。！？]\s*\S/;

/** Returns the prediction if it reads like a short message from the user, or null. */
export function normalizeCodexPromptSuggestion(text: string | null | undefined): string | null {
  const suggestion = (text ?? "")
    .trim()
    .replace(/^["'`“‘]+|["'`”’]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  const wordCount = suggestion.split(/\s+/).length;
  if (
    suggestion.length === 0 ||
    suggestion.length >= 100 ||
    wordCount > 12 ||
    /[\n*#`]/.test(suggestion) ||
    suggestion.endsWith("?") ||
    MULTIPLE_SENTENCES.test(suggestion) ||
    ASSISTANT_VOICE.test(suggestion) ||
    META_REPLY.test(suggestion) ||
    PRAISE.test(suggestion)
  ) {
    return null;
  }

  return suggestion;
}
