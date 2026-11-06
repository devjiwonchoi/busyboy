export type PlanDiffPart = {
  readonly kind: "same" | "insert" | "delete";
  readonly text: string;
};

/** Words and the whitespace between them, so joining the tokens gives the text back. */
function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

/** Word diff from `before` to `after` by longest common subsequence. */
export function diffWords(before: string, after: string): PlanDiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  // lengths[i][j]: LCS length of a[i..] and b[j..].
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const parts: PlanDiffPart[] = [];
  const push = (kind: PlanDiffPart["kind"], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      push("delete", a[i]!);
      i++;
    } else {
      push("insert", b[j]!);
      j++;
    }
  }
  while (i < a.length) push("delete", a[i++]!);
  while (j < b.length) push("insert", b[j++]!);
  return parts;
}
