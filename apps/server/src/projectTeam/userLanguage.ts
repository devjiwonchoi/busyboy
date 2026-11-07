/**
 * The language the user writes in, so task leads write what the user reads in it.
 * Told apart by script, which is enough for the languages users write here.
 */

const SCRIPTS: ReadonlyArray<{ readonly language: string; readonly pattern: RegExp }> = [
  { language: "Korean", pattern: /[ᄀ-ᇿ㄰-㆏가-힣]/gu },
  { language: "Japanese", pattern: /[぀-ヿ]/gu },
  { language: "Chinese", pattern: /[一-鿿]/gu },
];

/** The language a text is written in, or null when it has no letters to tell. */
export function languageOfText(text: string): string | null {
  // A few characters of another script, such as one quoted word, do not make the text that language.
  for (const { language, pattern } of SCRIPTS) {
    if ((text.match(pattern)?.length ?? 0) >= 2) return language;
  }
  return /[a-z]/i.test(text) ? "English" : null;
}

/**
 * The task's request decides when it is not English, since the PM often writes requests in
 * English for a user who does not. Otherwise the user's own recent chat messages decide.
 * Null means English, which needs no rule.
 */
export function resolveUserLanguage(
  request: string,
  userMessages: ReadonlyArray<string>,
): string | null {
  const fromRequest = languageOfText(request);
  if (fromRequest !== null && fromRequest !== "English") return fromRequest;
  const counts = new Map<string, number>();
  for (const message of userMessages) {
    const language = languageOfText(message);
    if (language !== null) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
  return top === undefined || top[0] === "English" ? null : top[0];
}

/** The lead prompt's rule for a user who does not write in English. */
export function userLanguageRule(language: string): string {
  return `The user writes in ${language}. Write everything the user reads in ${language}: every spec section (summary, goal, criteria, non-goals, todos and their doneWhen lines, file reasons), ask_user questions and options, task notes, and the plan and result summaries. Keep code, identifiers, file paths, commit messages and pull request text in English.`;
}
