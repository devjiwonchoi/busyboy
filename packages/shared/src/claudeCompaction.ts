/**
 * Copy for Claude's resume compaction dialog, shared by the server adapter
 * (which asks the question) and the web client (which recognizes the
 * question and its "never" answer in resolved user-input activities to
 * mirror the dismissal). Both sides must agree on these strings, so they
 * live here: reword the question or the answer label in this file only.
 */
export const CLAUDE_RESUME_COMPACTION_NEVER_ANSWER = "Don't ask again";

export function formatClaudeResumeCompactionQuestion(input: {
  readonly ageMinutes: number;
  readonly estimatedTokens: number;
}): string {
  const ageLabel =
    input.ageMinutes >= 60
      ? `${Math.floor(input.ageMinutes / 60)}h ${input.ageMinutes % 60}m`
      : `${input.ageMinutes}m`;
  return `This session is ${ageLabel} old and uses ${input.estimatedTokens.toLocaleString("en-US")} tokens. Compact it before continuing?`;
}

const CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN =
  /^This session is (?:\d+h \d+m|\d+m) old and uses \d{1,3}(?:,\d{3})* tokens\. Compact it before continuing\?$/u;

export function isClaudeResumeCompactionQuestion(question: string): boolean {
  return CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.test(question);
}

/**
 * Message ids of the "/compact" the server sends on its own while a thread is
 * idle. Clients hide these messages and keep the run out of the thread's
 * status. The PM prefix is kept so older PM compactions stay recognized.
 */
export const BACKGROUND_COMPACTION_MESSAGE_PREFIX = "context-care:compact:";
const LEGACY_PM_COMPACTION_MESSAGE_PREFIX = "project-team:compact:";
export const BACKGROUND_COMPACTION_MESSAGE_PREFIXES = [
  BACKGROUND_COMPACTION_MESSAGE_PREFIX,
  LEGACY_PM_COMPACTION_MESSAGE_PREFIX,
] as const;

export function isBackgroundCompactionMessageId(messageId: string): boolean {
  return BACKGROUND_COMPACTION_MESSAGE_PREFIXES.some((prefix) => messageId.startsWith(prefix));
}
