import { localIsoDate } from "./remember-record";

export type ProgressState = "calm" | "decision" | "at-risk";

export type TaskProgress = {
  total: number;
  verified: number;
  state: ProgressState;
};

export const CALM_PROGRESS: TaskProgress = { total: 0, verified: 0, state: "calm" };

type Item = { id: string | null; title: string };

type Line = { text: string; inFence: boolean };

const FENCE = /^\s*(```|~~~)/;
const DRAFT = /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*draft\b/im;
const NUMBERED = /^(\d+[a-z]?)\s*·\s*(.+)$/i;
const DEADLINE = /^\s*(?:-\s*)?Deadline:\s*(\d{4}-\d{2}-\d{2})\b/i;

export function sumProgress(parts: TaskProgress[]): TaskProgress {
  return {
    total: parts.reduce((sum, part) => sum + part.total, 0),
    verified: parts.reduce((sum, part) => sum + part.verified, 0),
    state: parts.some((part) => part.state === "at-risk")
      ? "at-risk"
      : parts.some((part) => part.state === "decision")
        ? "decision"
        : "calm",
  };
}

function toLines(text: string): Line[] {
  let inFence = false;
  return text.split(/\r?\n/).map((text) => {
    const isFence = FENCE.test(text);
    const line = { text, inFence: inFence || isFence };
    if (isFence) inFence = !inFence;
    return line;
  });
}

function headingOf(line: Line) {
  if (line.inFence) return null;
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.text);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}

function section(lines: Line[], name: string) {
  const start = lines.findIndex((line) => {
    const heading = headingOf(line);
    return heading?.level === 1 && heading.title.toLowerCase() === name;
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => headingOf(line)?.level === 1);
  return end === -1 ? rest : rest.slice(0, end);
}

function numberedHeadings(lines: Line[]): Item[] {
  const items: Item[] = [];
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading?.level !== 2) continue;
    const match = NUMBERED.exec(heading.title);
    if (match) items.push({ id: match[1].toLowerCase(), title: match[2].trim() });
  }
  return items;
}

function successCriteria(lines: Line[]): Item[] {
  const body = section(lines, "success criteria");
  if (!body) return [];
  const numbered = numberedHeadings(body);
  if (numbered.length > 0) return numbered;
  const items: Item[] = [];
  for (const line of body) {
    const heading = headingOf(line);
    if (heading?.level === 2) items.push({ id: null, title: heading.title });
  }
  return items;
}

function doneWhen(lines: Line[]): Item[] {
  const items: Item[] = [];
  for (const line of lines) {
    if (line.inFence) continue;
    const match = /^\s*-\s*Done when:\s*(.*)$/i.exec(line.text);
    if (match) items.push({ id: null, title: match[1].trim() });
  }
  return items;
}

// why: # Later and # Criteria sit outside # End state, so they are not items.
export function endStateItems(align: string): Item[] {
  const lines = toLines(align);
  const endState = section(lines, "end state");
  const numbered = endState ? numberedHeadings(endState) : [];
  if (numbered.length > 0) return numbered;
  const criteria = successCriteria(lines);
  if (criteria.length > 0) return criteria;
  return doneWhen(lines);
}

function isDraft(text: string) {
  return DRAFT.test(text);
}

export function contractText(approved: string | null, align: string | null): string | null {
  if (approved !== null) return isDraft(approved) ? null : approved;
  if (align !== null && !isDraft(align)) return align;
  return null;
}

function norm(text: string) {
  return text.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function idAtStart(text: string, id: string) {
  return (
    text === id ||
    text.startsWith(`${id} `) ||
    text.startsWith(`${id}·`) ||
    text.startsWith(`${id} ·`)
  );
}

function itemIndex(items: Item[], cell: string) {
  const value = norm(cell);
  if (!value) return -1;
  const byId = items.findIndex((item) => item.id !== null && idAtStart(value, item.id));
  if (byId !== -1) return byId;
  let best = -1;
  let bestLength = 0;
  items.forEach((item, index) => {
    const title = norm(item.title);
    if (title && value.includes(title) && title.length > bestLength) {
      best = index;
      bestLength = title.length;
    }
  });
  return best;
}

type Verdict = "pass" | "fail" | "other";

function verdictOf(text: string): Verdict | null {
  const value = text.trim();
  if (!value) return null;
  if (/^\W*(fail|failed|not met)\b/i.test(value)) return "fail";
  if (/^\W*(pass|passed|ok|met|proven)\b/i.test(value)) return "pass";
  return "other";
}

function tableCells(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isSeparator = (cells: string[]) => cells.every((cell) => /^:?-{3,}:?$/.test(cell));

export function verifyOutcome(
  verify: string | null,
  items: Item[],
): { verified: number; failed: boolean } {
  const results = new Map<number, Verdict>();
  let unmatchedFail = false;
  if (!verify) return { verified: 0, failed: false };
  const lines = toLines(verify);
  let current: number | null = null;
  let header: string[] | null = null;
  const record = (index: number | null, verdict: Verdict) => {
    if (index === null || index < 0) {
      if (verdict === "fail") unmatchedFail = true;
      return;
    }
    results.set(index, verdict);
  };
  lines.forEach((line, index) => {
    const heading = headingOf(line);
    if (heading) {
      header = null;
      current = heading.level === 2 ? itemIndex(items, heading.title) : null;
      if (current === -1) current = null;
      return;
    }
    if (line.inFence) return;
    const cells = tableCells(line.text);
    if (cells) {
      if (isSeparator(cells)) return;
      const next = lines[index + 1];
      const nextCells = next && !next.inFence ? tableCells(next.text) : null;
      if (nextCells && isSeparator(nextCells)) {
        header = cells;
        return;
      }
      if (!header) return;
      const itemColumn = header.findIndex((cell) => /criteri|item|end state|done when/i.test(cell));
      const resultColumn = header.findIndex((cell) => /^(result|status)$/i.test(cell));
      if (itemColumn === -1 || resultColumn === -1) return;
      const verdict = verdictOf(cells[resultColumn] ?? "");
      if (!verdict) return;
      const found = itemIndex(items, cells[itemColumn] ?? "");
      record(found === -1 ? null : found, verdict);
      return;
    }
    const labeled = /^\s*-\s+([^:]+):\s*(.*)$/.exec(line.text);
    if (!labeled) return;
    const label = labeled[1].trim();
    const verdict = verdictOf(labeled[2]);
    if (!verdict) return;
    if (/^(result|proof|wanted|got)$/i.test(label)) {
      if (/^result$/i.test(label)) record(current, verdict);
      return;
    }
    const found = itemIndex(items, label);
    record(found === -1 ? null : found, verdict);
  });
  return {
    verified: [...results.values()].filter((verdict) => verdict === "pass").length,
    failed: unmatchedFail || [...results.values()].some((verdict) => verdict === "fail"),
  };
}

function structuredOwnerQuestion(line: string): boolean | null {
  if (!/^\s*-\s*Root\s*:/i.test(line)) return null;
  const parts = line.split("·").map((part) => part.trim());
  const doorIndex = parts.findIndex((part) => /^(one-way|two-way)$/i.test(part));
  if (doorIndex < 0 || doorIndex + 1 >= parts.length) return false;
  const door = parts[doorIndex].toLowerCase();
  const status = parts[doorIndex + 1].toLowerCase();
  return door === "one-way" && /^open\b/.test(status);
}

const closedOrTwoWay = (text: string) =>
  /\b(resolved|answered|closed|covered|done|two-way)\b/i.test(text);

export function ownerDecision(status: string | null): boolean {
  if (!status) return false;
  const lines = toLines(status);
  let inPending = false;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      inPending = heading.level === 2 && heading.title.toLowerCase() === "pending";
      continue;
    }
    if (line.inFence) continue;
    const structured = structuredOwnerQuestion(line.text);
    if (structured !== null) {
      if (structured) return true;
      continue;
    }
    if (inPending && /^\s*-\s+\S/.test(line.text) && !closedOrTwoWay(line.text)) return true;
    const pending = /^\s*-\s*Pending(?:\s+decision)?\s*:\s*(.+)$/i.exec(line.text);
    if (pending && !closedOrTwoWay(pending[1])) return true;
  }
  return false;
}

export function deadlinePassed(texts: (string | null)[], today = localIsoDate()): boolean {
  for (const text of texts) {
    if (!text) continue;
    for (const line of toLines(text)) {
      if (line.inFence) continue;
      const match = DEADLINE.exec(line.text);
      if (match && match[1] < today) return true;
    }
  }
  return false;
}

export function deriveProgress({
  approved,
  align,
  status,
  verify,
}: {
  approved: string | null;
  align: string | null;
  status: string | null;
  verify: string | null;
}): TaskProgress {
  const contract = contractText(approved, align);
  const items = contract ? endStateItems(contract) : [];
  const outcome = verifyOutcome(verify, items);
  let state: ProgressState = "calm";
  if (ownerDecision(status)) state = "decision";
  if (outcome.failed || deadlinePassed([status, approved, align])) state = "at-risk";
  return { total: items.length, verified: outcome.verified, state };
}
