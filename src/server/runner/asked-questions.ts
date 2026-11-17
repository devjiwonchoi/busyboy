import type { Question, QuestionOption } from "./contract";

// Claude and Codex question payloads do not match their own tool schemas.

const QUESTION_TEXT = ["question", "title", "prompt", "text"] as const;
const OPTION_LABEL = ["label", "text", "name", "value", "title"] as const;
const OPTION_DETAIL = ["description", "detail", "hint"] as const;

const RECOMMENDED_PREFIX = /^\s*(?:\((?:recommended)\)|\[(?:recommended)\])\s+/i;
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended)\)|\[(?:recommended)\])\s*$/i;

function textOf(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function flagged(value: unknown) {
  return value === true || value === "true";
}

// A choice whose words merely include "recommended" is left as written.
function normalizeLabel(label: string, marked = false) {
  const prefix = RECOMMENDED_PREFIX.exec(label);
  const suffix = RECOMMENDED_SUFFIX.exec(label);
  let text = label.trim();
  if (prefix) text = text.slice(prefix[0].length).trim();
  if (suffix) text = text.slice(0, text.length - suffix[0].length).trim();
  if (!text) return label.trim();
  return marked || prefix || suffix ? `${text} (Recommended)` : text;
}

function optionFrom(value: unknown): QuestionOption | null {
  if (typeof value === "string") {
    const label = normalizeLabel(value);
    return label ? { label } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw = textOf(record, OPTION_LABEL);
  if (!raw) return null;
  const marked =
    flagged(record.recommended) || flagged(record.isRecommended) || flagged(record.is_recommended);
  const description = textOf(record, OPTION_DETAIL);
  return { label: normalizeLabel(raw, marked), ...(description ? { description } : {}) };
}

function optionsOf(value: unknown): QuestionOption[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const options: QuestionOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const option = optionFrom(item);
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
  }
  return options;
}

function isMulti(record: Record<string, unknown>) {
  const value =
    record.multiSelect ?? record.multi_select ?? record.allowMultiple ?? record.allow_multiple;
  return value === true || value === "true";
}

function itemsOf(value: unknown): unknown[] | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return null;
    try {
      return itemsOf(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ("questions" in record && record.questions != null) {
    const nested = itemsOf(record.questions);
    if (nested) return nested;
  }
  if (textOf(record, ["question", "title", "prompt"])) return [record];
  return null;
}

function questionFrom(value: unknown): Question | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const question = textOf(record, QUESTION_TEXT);
  if (!question) return null;
  const header = textOf(record, ["header"]);
  return {
    question,
    ...(header && header !== question ? { header } : {}),
    multiSelect: isMulti(record),
    options: optionsOf(record.options ?? record.choices),
  };
}

export function parseAskedQuestions(value: unknown): Question[] | null {
  const items = itemsOf(value);
  if (!items) return null;
  const questions = items
    .map(questionFrom)
    .filter((question): question is Question => question !== null);
  return questions.length > 0 ? questions : null;
}
