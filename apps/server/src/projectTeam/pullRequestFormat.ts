export interface PullRequestText {
  readonly title: string;
  readonly body: string;
}

export const PR_TITLE_MAX_CHARS = 60;

const TASK_KEY = /\b[A-Z][A-Z0-9]{0,9}-\d+\b/g;
const ISSUE_REF = /\(#\d+\)/;
const HEADING = /^#{1,6}\s/;
const WHY = "### Why?";
const HOW = "### How?";
const STACK_LINE = /^Stacked on #\d+\.$/;
const VALIDATION_LABEL =
  /^\s*(?:[-*]\s*)?(?:validation|verification|verified|tested|testing|tests?|test plan|checks?)\b\s*[:：]/i;
const CHECKBOX = /^\s*[-*]\s*\[[ xX]\]/;
const TEST_COMMAND =
  /\b(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|typecheck|lint)\b|vitest\b|vp\s+test\b|jest\b|pytest\b|cargo\s+test\b|go\s+test\b)/i;
const EXAMPLE_TITLE = `"Fix login redirect"`;

/** Each problem is one line that says what is wrong AND the exact fix. Empty = conforming. */
export function pullRequestFormatProblems(pr: PullRequestText): ReadonlyArray<string> {
  return [...titleProblems(pr.title.trim()), ...bodyProblems(pr.body)];
}

function titleProblems(title: string): Array<string> {
  const problems: Array<string> = [];
  const quoted = JSON.stringify(title);
  if (title.length === 0) {
    return [`The title is empty: set it to an action verb + change, such as ${EXAMPLE_TITLE}.`];
  }
  if (title.length > PR_TITLE_MAX_CHARS) {
    problems.push(
      `The title ${quoted} is ${title.length} chars: shorten the title to an action verb + change (${PR_TITLE_MAX_CHARS} chars max), such as ${EXAMPLE_TITLE}; move details to ### How?`,
    );
  }
  const keys = uniqueMatches(title, TASK_KEY);
  if (keys.length > 0 || ISSUE_REF.test(title)) {
    const refs = [...keys, ...(title.match(/\(#\d+\)/g) ?? [])].join(", ");
    problems.push(
      `The title ${quoted} contains ${refs}: remove task keys and (#N) refs from the title; BusyBoy links the task itself.`,
    );
  }
  if (title.includes(":")) {
    problems.push(
      `The title ${quoted} has a colon: drop the "X: a, b, c" list and use one action verb + change, such as ${EXAMPLE_TITLE}; move details to ### How?`,
    );
  }
  if (title.endsWith(".")) {
    problems.push(`The title ${quoted} ends with a period: remove the trailing period.`);
  }
  if (!/^[A-Z]/.test(title)) {
    problems.push(
      `The title ${quoted} does not start with a capitalized verb: start it with an action verb like Fix, Add or Show, such as ${EXAMPLE_TITLE}.`,
    );
  }
  return problems;
}

function bodyProblems(rawBody: string): Array<string> {
  const lines = rawBody
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const problems: Array<string> = [];

  const whyIndex = lines.findIndex((line) => line.trim() === WHY);
  const howIndex = lines.findIndex((line) => line.trim() === HOW);
  if (whyIndex === -1) {
    problems.push(
      `The body has no "${WHY}" heading: add "${WHY}" with a paragraph on why the change is needed.`,
    );
  }
  if (howIndex === -1) {
    problems.push(
      `The body has no "${HOW}" heading: add "${HOW}" with a paragraph on how the change works.`,
    );
  }
  if (whyIndex !== -1 && howIndex !== -1 && howIndex < whyIndex) {
    problems.push(`"${HOW}" comes before "${WHY}": put "${WHY}" first, then "${HOW}".`);
  }

  // Other headings, and repeated Why?/How? headings.
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!HEADING.test(trimmed)) continue;
    if ((trimmed === WHY || trimmed === HOW) && !seen.has(trimmed)) {
      seen.add(trimmed);
      continue;
    }
    problems.push(
      trimmed === WHY || trimmed === HOW
        ? `The body repeats "${trimmed}": keep one "${WHY}" and one "${HOW}" section.`
        : `Remove the "${trimmed}" section: the body has only ${WHY} and ${HOW}`,
    );
  }

  // Text before the first section must be only the stack line.
  const firstSection = [whyIndex, howIndex].filter((index) => index !== -1);
  const preambleEnd = firstSection.length > 0 ? Math.min(...firstSection) : lines.length;
  const preamble = lines
    .slice(0, preambleEnd)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !HEADING.test(line));
  const stackOnly =
    preamble.length === 0 || (preamble.length === 1 && STACK_LINE.test(preamble[0]!));
  if (!stackOnly && firstSection.length > 0) {
    problems.push(
      `The body has text before "${WHY}": remove it; only a "Stacked on #N." line may come first.`,
    );
  }

  // Empty sections.
  if (whyIndex !== -1 && howIndex !== -1) {
    for (const [heading, start] of [
      [WHY, whyIndex],
      [HOW, howIndex],
    ] as const) {
      const next = lines.findIndex((line, index) => index > start && HEADING.test(line.trim()));
      const content = lines
        .slice(start + 1, next === -1 ? lines.length : next)
        .some((line) => line.trim().length > 0);
      if (!content) {
        problems.push(`The "${heading}" section is empty: write at least one paragraph under it.`);
      }
    }
  }

  if (
    lines.some(
      (line) => VALIDATION_LABEL.test(line) || CHECKBOX.test(line) || TEST_COMMAND.test(line),
    )
  ) {
    problems.push(
      "The body has validation notes: remove validation notes; the PR body says why and how, not how it was tested.",
    );
  }

  for (const key of uniqueMatches(lines.join("\n"), TASK_KEY)) {
    problems.push(
      `The body mentions ${key}: remove the task key ${key}; BusyBoy links the task itself.`,
    );
  }
  return problems;
}

// Standards names that look like task keys (UTF-8, SHA-256, ISO-8601).
const NOT_TASK_KEYS = new Set([
  "UTF",
  "SHA",
  "ISO",
  "RFC",
  "ES",
  "ECMA",
  "CVE",
  "TLS",
  "HTTP",
  "IPV",
]);

function uniqueMatches(text: string, pattern: RegExp): Array<string> {
  const found = (text.match(pattern) ?? []).filter(
    (match) => !NOT_TASK_KEYS.has(match.slice(0, match.indexOf("-"))),
  );
  return [...new Set(found)];
}
