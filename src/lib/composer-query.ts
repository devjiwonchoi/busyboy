// why: A file mention's query may contain a path (`src/app.tsx`). A slash that is
// why: not its own trigger still belongs to that query.
const QUERY_BODY = /^[\p{L}\p{M}\p{N}\p{Zs}_.’'./\\-]*$/u;
const QUERY_SUFFIX = /^[\p{L}\p{M}\p{N}_.’'./\\-]*/u;

export function getComposerQuery(
  text: string,
  caret: number,
  triggers: readonly string[],
): { character: string; text: string; start: number; end: number } | null {
  const candidates: { start: number; character: string }[] = [];
  for (const trigger of triggers) {
    if (!trigger || trigger.length > caret) continue;
    let index = text.lastIndexOf(trigger, caret - trigger.length);
    while (index >= 0) {
      candidates.push({ start: index, character: trigger });
      if (index === 0) break;
      index = text.lastIndexOf(trigger, index - 1);
    }
  }
  candidates.sort((left, right) => right.start - left.start);

  for (const { start, character } of candidates) {
    // why: A trigger in the middle of a word is part of the text, not a picker.
    if (start > 0 && !/\s/u.test(text.charAt(start - 1))) continue;
    const beforeCaret = text.slice(start + character.length, caret);
    if (/^\s/u.test(beforeCaret) || !QUERY_BODY.test(beforeCaret)) continue;
    const suffix = QUERY_SUFFIX.exec(text.slice(caret))?.[0] ?? "";
    return {
      character,
      text: (beforeCaret + suffix).replace(/\p{Zs}+/gu, " ").trim(),
      start,
      end: caret + suffix.length,
    };
  }
  return null;
}
