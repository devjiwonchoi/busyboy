import { PLAN_APPROVAL_START } from "@t3tools/contracts";

export const REQUEST_APPROVE_LABEL = "승인";
export const REQUEST_DETAILS_LABEL = "자세히 보기";
export const REQUEST_BLOCKER_DONE = "처리했어요";

export function parseRequestMessage(question: string): {
  headline: string;
  paragraphs: string[];
  steps: string[];
} {
  const [headline = "", ...lines] = question.trim().split(/\r?\n/);
  const paragraphs: string[] = [];
  const steps: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length > 0) {
      paragraphs.push(block.join("\n"));
      block = [];
    }
  };
  for (const line of lines) {
    // Only a run counted from 1 is a step list, so "2026. 11월" stays in its paragraph.
    const step = line.trim().match(/^(\d+)[.)]\s+(.*)$/);
    if (step && Number(step[1]) === steps.length + 1) {
      flush();
      steps.push(step[2]!);
    } else if (line.trim() === "") {
      flush();
    } else {
      block.push(line.trim());
    }
  }
  flush();
  return { headline: headline.trim(), paragraphs, steps };
}

export function requestMessageProblems(
  question: string,
  details?: ReadonlyArray<{ label: string; text: string }> | null,
): string[] {
  const { headline, paragraphs, steps } = parseRequestMessage(question);
  const problems: string[] = [];
  if (!headline) {
    problems.push("A headline is required.");
  }
  if (headline.length > 80) {
    problems.push("Keep the headline within 80 characters.");
  }
  if (headline.endsWith(":")) {
    problems.push("The headline must not end with a colon.");
  }
  if (/^\s*#/m.test(question)) {
    problems.push("Remove markdown headings.");
  }
  if (/^\s*(?:\*\*)?[\p{L}][\p{L}\p{N} _-]{0,30}:\s*(?:\*\*)?/mu.test(question)) {
    problems.push("Remove label lines such as Goal: or **Goal:**.");
  }
  if (/^\s*[-*]\s/m.test(question)) {
    problems.push("Replace bullet lists with plain paragraphs or numbered steps.");
  }
  if (paragraphs.length > 3 || paragraphs.some((p) => p.length > 400)) {
    problems.push("Use at most 3 paragraphs, each within 400 characters.");
  }
  if (steps.length > 8 || steps.some((s) => s.length > 60)) {
    problems.push("Use at most 8 numbered steps, each within 60 characters.");
  }
  if (
    (details?.length ?? 0) > 8 ||
    details?.some(
      (d) => !d.label.trim() || d.label.length > 20 || !d.text.trim() || d.text.length > 500,
    )
  ) {
    problems.push(
      "Use at most 8 details with a nonempty label within 20 characters and text within 500 characters.",
    );
  }

  // Both the visible message and folded details must use language the user understands.
  const texts = [question, ...(details ?? []).map((d) => d.text)];
  problems.push(...plainTextProblems(texts));
  return problems;
}

const TASK_KEY = /\b[A-Z]{2,6}-\d+\b/g;
// Everyday names that look like task keys or camelCase identifiers.
const KEY_LIKE_WORDS = /^(?:UTF|SHA|GPT|ISO|ES|COVID|MD|RFC)-/;
const PRODUCT_WORDS = /\b(?:iOS|iPadOS|macOS|watchOS|tvOS|visionOS|iPhone|iPad|iCloud|eSIM)\b/g;

export function stripTaskKeys(text: string): string {
  return text.replace(TASK_KEY, (word) => (KEY_LIKE_WORDS.test(word) ? word : ""));
}

// Reuse the same technical-language checks for messages, step titles and sender names.
export function plainTextProblems(input: ReadonlyArray<string>): string[] {
  const texts = input.map((text) => text.replace(PRODUCT_WORDS, " "));
  const problems: string[] = [];
  if (texts.some((text) => stripTaskKeys(text) !== text)) {
    problems.push("Remove task keys; use the work's name.");
  }
  for (const [pattern, problem] of [
    [
      /(?:t3-task:|task:|attention:|thread:|project-pm:|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i,
      "Remove internal ids and task links.",
    ],
    [/`/, "Remove inline code and backticks."],
    [
      /(?:\w+\/\w+\.\w{1,5}\b|\b(?:apps|packages)\/)/,
      "Remove file paths; describe the affected behavior.",
    ],
    [
      /\b[a-z]+[A-Z][a-zA-Z0-9]*\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/,
      "Replace camelCase and snake_case identifiers with plain words.",
    ],
  ] as const) {
    if (texts.some((text) => pattern.test(text))) {
      problems.push(problem);
    }
  }
  return problems;
}

export function todoTitleProblems(text: string): string[] {
  const problems = plainTextProblems([text]);
  if (!text.trim() || /[\r\n]/.test(text)) {
    problems.push("Keep the title on one nonempty line.");
  }
  if (text.length > 40) {
    problems.push("Keep the title within 40 characters.");
  }
  return problems;
}

// Old task titles can include keys and planning context that do not belong in a sender label.
export function shortWorkName(title: string): string {
  const cleaned = title
    .replace(/\([^()]*\)|（[^（）]*）/g, "")
    .replace(/\s+/g, " ");
  const name = stripTaskKeys(cleaned)
    .split(/·|,| - /)[0]!
    .replace(/\s+/g, " ")
    .trim();
  if (name.length <= 16) {
    return name;
  }
  const prefix = name.slice(0, 16);
  const boundary = prefix.lastIndexOf(" ");
  return boundary > 0 && name[16] !== " " ? prefix.slice(0, boundary) : prefix;
}

export function requestSenderLabel({
  role,
  name,
  projectTitle,
}: {
  role: "lead" | "pm" | "director" | null;
  name: string | null;
  projectTitle: string;
}): string | null {
  if (role === "director") {
    return "Director";
  }
  if (role === null) {
    return null;
  }
  const project = stripTaskKeys(projectTitle).trim();
  if (role === "pm") {
    return `${project} · PM`;
  }
  const work = name === null ? "" : stripTaskKeys(name).trim();
  return `${project} · ${work ? `${work} 리드` : "리드"}`;
}

export function requestLinkHref(id: string): string {
  return `t3-request:${encodeURIComponent(id)}`;
}

export function formatRequestLink(id: string, headline: string): string {
  return `[↩ ${headline.replace(/[\[\]\\]/g, "\\$&")}](${requestLinkHref(id)})`;
}

export function requestLinkIds(text: string): string[] {
  return Array.from(text.matchAll(/t3-request:([^\s)<>\]]+)/g), (match) => {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      // A mangled link keeps its raw id, which then matches no open request.
      return match[1]!;
    }
  });
}

export function matchRequestReference(
  text: string,
  openItems: ReadonlyArray<{ id: string; question: string }>,
):
  | { kind: "link"; id: string }
  | { kind: "words"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" } {
  const links = [...new Set(requestLinkIds(text))];
  if (links.length > 1) {
    return { kind: "ambiguous", ids: links };
  }
  if (links[0]) {
    return { kind: "link", id: links[0] };
  }

  // Strip conversational filler before scoring meaningful headline words.
  const tokens = (value: string) => [
    ...new Set(
      (value.match(/[가-힣]+|[a-zA-Z]+/g) ?? [])
        .map((word) => word.toLowerCase().replace(/(?:은|는|이|가|을|를|건|거|요)$/, ""))
        .filter(
          (word) => word.length >= 2 && !/^(?:그거|승인|플랜|부탁드려|해도|될까|요청)$/.test(word),
        ),
    ),
  ];
  const words = tokens(text);
  const headlines = openItems.map((item) => ({
    id: item.id,
    tokens: tokens(parseRequestMessage(item.question).headline),
  }));
  const matches = (token: string) =>
    words.some((word) => word.startsWith(token) || token.startsWith(word));
  // Only words that belong to a single open request can point at it; shared words are ambiguous.
  const shared = (token: string) =>
    headlines.filter((other) => other.tokens.includes(token)).length > 1;
  const scored = headlines.map((item) => ({
    id: item.id,
    score: item.tokens.filter((token) => !shared(token) && matches(token)).length,
  }));
  const best = Math.max(0, ...scored.map((item) => item.score));
  if (best === 0) {
    const touched = headlines.filter((item) => item.tokens.some(matches)).map((item) => item.id);
    return touched.length > 0 ? { kind: "ambiguous", ids: touched } : { kind: "none" };
  }
  const ids = scored.filter((item) => item.score === best).map((item) => item.id);
  if (ids.length > 1) {
    return { kind: "ambiguous", ids };
  }
  return { kind: "words", id: ids[0]! };
}

// The recommended option, else the first one, for both 승인 and the folded option list.
export function defaultRequestOption(options: ReadonlyArray<string>): string | null {
  return options.find((option) => /\((?:Recommended|추천)\)/i.test(option)) ?? options[0] ?? null;
}

export function formatRequestAnswer(option: string, note: string): string {
  const trimmed = note.trim();
  return trimmed ? `${option}\nNote: ${trimmed}` : option;
}

export function approveAnswerFor(item: { kind: string; options: ReadonlyArray<string> }): string {
  if (item.kind === "approval") {
    return PLAN_APPROVAL_START;
  }
  if (item.kind === "blocker") {
    return REQUEST_BLOCKER_DONE;
  }
  return defaultRequestOption(item.options) ?? REQUEST_APPROVE_LABEL;
}
