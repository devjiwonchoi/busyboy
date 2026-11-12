import type {
  NodeContract,
  NodeContractCriterion,
  NodeCriterionCheck,
  NodeCriterionStatus,
  NodeEvidenceBy,
  NodeExpectedFile,
  NodeFileChangeKind,
  NodeIssue,
  NodeReviewFinding,
  NodeState,
  NodeWaitsOn,
} from "@t3tools/contracts";

/**
 * Reads the Markdown records the jwn skills keep under `.jwn/<task>/`.
 *
 * The skills promise only their fixed headings, so this reads by heading and
 * line, skips fenced code, and reports whatever it cannot read as an issue
 * instead of dropping the record.
 */

export const RECORD_FILES = ["ALIGN.md", "STATUS.md", "VERIFY.md", "REVIEW.md"] as const;
export type RecordFileName = (typeof RECORD_FILES)[number];

/** File contents by name; a file that exists but could not be read carries its error. */
export type RecordFiles = Partial<Record<RecordFileName, string | { readonly error: string }>>;

export interface VerifyRow {
  readonly label: string;
  readonly status: NodeCriterionStatus;
  readonly evidence: string;
  readonly by: NodeEvidenceBy | null;
}

export interface ParsedRecord {
  readonly contract: NodeContract | null;
  readonly state: NodeState;
  readonly statusText: string | null;
  readonly verifyRows: ReadonlyArray<VerifyRow>;
  readonly reviewFindings: ReadonlyArray<NodeReviewFinding>;
  readonly issues: ReadonlyArray<NodeIssue>;
}

interface Line {
  readonly text: string;
  /** True for fence markers and everything between them. */
  readonly inFence: boolean;
}

const FENCE = /^\s*(```|~~~)/;

const toLines = (text: string): ReadonlyArray<Line> => {
  let inFence = false;
  return text.split(/\r?\n/).map((raw) => {
    const isFence = FENCE.test(raw);
    const line = { text: raw, inFence: inFence || isFence };
    if (isFence) inFence = !inFence;
    return line;
  });
};

const headingOf = (line: Line): { readonly level: number; readonly title: string } | null => {
  if (line.inFence) return null;
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.text);
  if (!match) return null;
  return { level: match[1]!.length, title: match[2]! };
};

/** Section titles may carry a reading number such as `# 4 · Success criteria`. */
const sectionTitle = (title: string) =>
  title
    .replace(/^\d+[a-z]?\s*·\s*/i, "")
    .trim()
    .toLowerCase();

/** The lines under the first level-1 heading whose title matches, up to the next level-1 heading. */
const section = (lines: ReadonlyArray<Line>, matches: (title: string) => boolean) => {
  const start = lines.findIndex((line) => {
    const heading = headingOf(line);
    return heading?.level === 1 && matches(sectionTitle(heading.title));
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => headingOf(line)?.level === 1);
  return end === -1 ? rest : rest.slice(0, end);
};

const firstMatch = (lines: ReadonlyArray<Line>, pattern: RegExp) => {
  for (const line of lines) {
    if (line.inFence) continue;
    const match = pattern.exec(line.text);
    if (match) return match;
  }
  return null;
};

const NUMBERED_HEADING = /^(\d+[a-z]?)\s*·\s*(.+)$/i;

const parseCriteria = (lines: ReadonlyArray<Line>): ReadonlyArray<NodeContractCriterion> => {
  const criteria: Array<NodeContractCriterion> = [];
  let current: {
    id: string;
    text: string;
    check: NodeCriterionCheck | null;
    how: string | null;
  } | null = null;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      if (current) criteria.push(current);
      const numbered = heading.level === 2 ? NUMBERED_HEADING.exec(heading.title) : null;
      current = numbered
        ? { id: numbered[1]!, text: numbered[2]!.trim(), check: null, how: null }
        : null;
      continue;
    }
    if (!current || line.inFence) continue;
    const check = /^\s*-\s*Check:\s*(auto|evidence|human)\b/i.exec(line.text);
    if (check) current.check = check[1]!.toLowerCase() as NodeCriterionCheck;
    const how = /Proven (?:by|in [^:]+):\s*(.+)$/i.exec(line.text);
    if (how && current.how === null) current.how = how[1]!.trim();
  }
  if (current) criteria.push(current);
  return criteria;
};

const parseDont = (lines: ReadonlyArray<Line>): ReadonlyArray<string> =>
  lines
    .filter((line) => !line.inFence)
    .map((line) => /^\s*-\s+(.+)$/.exec(line.text)?.[1]?.trim())
    .filter((text): text is string => text !== undefined && !/:\s*none\.?$/i.test(text));

const CHANGE_MARKER = /#\s*(NEW|MODIFIED|DELETED)\b/i;

/** Reads the fenced block under a `File tree` heading, nested by indentation or flat. */
const parseFileTree = (lines: ReadonlyArray<Line>): ReadonlyArray<NodeExpectedFile> => {
  const start = lines.findIndex((line) => {
    const heading = headingOf(line);
    return heading !== null && sectionTitle(heading.title) === "file tree";
  });
  if (start === -1) return [];
  const files: Array<NodeExpectedFile> = [];
  const stack: Array<{ indent: number; name: string }> = [];
  let opened = false;
  for (const line of lines.slice(start + 1)) {
    if (FENCE.test(line.text)) {
      if (opened) break;
      opened = true;
      continue;
    }
    if (!opened) {
      if (headingOf(line)) break;
      continue;
    }
    const match = /^(\s*)(\S+)(.*)$/.exec(line.text);
    if (!match || match[2]!.startsWith("#")) continue;
    const indent = match[1]!.length;
    const name = match[2]!;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const path = [...stack.map((entry) => entry.name), name].join("");
    if (name.endsWith("/")) stack.push({ indent, name });
    const marker = CHANGE_MARKER.exec(match[3]!);
    if (marker || !name.endsWith("/")) {
      files.push({
        path,
        change: marker ? (marker[1]!.toLowerCase() as NodeFileChangeKind) : null,
      });
    }
  }
  return files;
};

const parseWaitsOn = (
  lines: ReadonlyArray<Line>,
  issues: Array<NodeIssue>,
): ReadonlyArray<NodeWaitsOn> => {
  const waits: Array<NodeWaitsOn> = [];
  for (const line of lines) {
    if (line.inFence) continue;
    const match = /^\s*(?:-\s*)?Waits on:\s*(.+)$/i.exec(line.text);
    if (!match) continue;
    for (const part of match[1]!.split(/[,;]/)) {
      const target = /^\s*`?([^\s`]+)`?\s+criteri(?:on|a)\s+(\S+?)\.?\s*$/i.exec(part);
      if (target) {
        waits.push({ node: target[1]!, criterion: target[2]! });
      } else if (!/^\s*none\.?\s*$/i.test(part)) {
        issues.push({
          kind: "invalid_line",
          file: "ALIGN.md",
          message: `Waits on 항목을 읽지 못했습니다: "${part.trim()}"`,
        });
      }
    }
  }
  return waits;
};

export const parseAlign = (
  id: string,
  text: string,
): { readonly contract: NodeContract; readonly issues: ReadonlyArray<NodeIssue> } => {
  const lines = toLines(text);
  const issues: Array<NodeIssue> = [];
  const title = firstMatch(lines, /^#\s+ALIGN:\s*(.+?)\s*$/)?.[1];
  if (title === undefined) {
    issues.push({
      kind: "missing_title",
      file: "ALIGN.md",
      message: "첫 제목 '# ALIGN: <제목>'이 없습니다.",
    });
  }
  const version = firstMatch(lines, /^\s*Version:\s*(\d+)/i)?.[1];
  const approved = firstMatch(lines, /Status:\s*approved by\s+(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})/i);
  const criteriaLines = section(lines, (name) => name === "success criteria");
  const criteria = criteriaLines ? parseCriteria(criteriaLines) : [];
  if (criteria.length === 0) {
    issues.push({
      kind: "missing_criteria",
      file: "ALIGN.md",
      message: criteriaLines
        ? "'Success criteria' 섹션에 '## n · 기준' 형식의 기준이 없습니다."
        : "'# Success criteria' 섹션이 없습니다.",
    });
  }
  const dontLines = section(lines, (name) => /^don[’']?ts$/.test(name));
  return {
    contract: {
      id,
      title: title ?? id,
      version: version === undefined ? null : Number(version),
      approved: approved ? { by: approved[1]!, on: approved[2]! } : null,
      parent: firstMatch(lines, /^\s*(?:-\s*)?Parent:\s*`?([^\s`]+)`?\s*$/i)?.[1] ?? null,
      purpose: firstMatch(lines, /^\s*Intention:\s*(.+?)\s*$/i)?.[1] ?? null,
      criteria,
      dont: dontLines ? parseDont(dontLines) : [],
      waitsOn: parseWaitsOn(lines, issues),
      expectedFiles: parseFileTree(lines),
    },
    issues,
  };
};

const STATE_PATTERNS: ReadonlyArray<readonly [RegExp, NodeState]> = [
  [/^(done|complete|completed|finished|merged|shipped)\b/i, "done"],
  [/^(waiting|asking|blocked|needs? (the )?user)\b/i, "asking"],
  [/^(failed|failing|error)\b/i, "failed"],
  [/^(stopped|cancel|paused|abandon|on hold)/i, "stopped"],
  [/^(draft|planning|aligning)\b/i, "draft"],
  [/review/i, "review"],
  [/^(continuing|running|in progress|implementing|iterating|verifying|shipping)\b/i, "running"],
];

export const parseStatusState = (text: string): NodeState => {
  const value = firstMatch(toLines(text), /^\s*(?:-\s*)?(?:State|Stage):\s*(.+)$/i)?.[1]?.trim();
  if (value === undefined) return "unknown";
  return STATE_PATTERNS.find(([pattern]) => pattern.test(value))?.[1] ?? "unknown";
};

export const resultStatus = (result: string): NodeCriterionStatus => {
  if (/^\s*\**\s*(pass|passed|ok|proven|yes|met|✅|통과)/i.test(result)) return "proven";
  if (/^\s*\**\s*(fail|failed|not met|no\b|❌|실패)/i.test(result)) return "failed";
  return "pending";
};

const BY_VALUE = /^(ci|reviewer|worker|human)$/i;

/** Who produced the evidence, only when the record says so: a `By` cell or a `by:` marker. */
const evidenceBy = (byCell: string | null, evidence: string): NodeEvidenceBy | null => {
  const cell = byCell?.trim().toLowerCase() ?? "";
  if (BY_VALUE.test(cell)) return cell as NodeEvidenceBy;
  const marker = /\bby:\s*(ci|reviewer|worker|human)\b/i.exec(evidence);
  return marker ? (marker[1]!.toLowerCase() as NodeEvidenceBy) : null;
};

const tableCells = (text: string): ReadonlyArray<string> | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
};

const isSeparatorRow = (cells: ReadonlyArray<string>) =>
  cells.every((cell) => /^:?-{3,}:?$/.test(cell));

export const parseVerify = (text: string): ReadonlyArray<VerifyRow> => {
  const rows: Array<VerifyRow> = [];
  let columns: { label: number; result: number; evidence: number; by: number } | null = null;
  let headingStatus: NodeCriterionStatus = "pending";
  for (const line of toLines(text)) {
    if (line.inFence) continue;
    const heading = headingOf(line);
    if (heading) {
      headingStatus = /\bPASS(ED)?\b/.test(heading.title)
        ? "proven"
        : /\bFAIL(ED)?\b/.test(heading.title)
          ? "failed"
          : "pending";
      columns = null;
      continue;
    }
    const cells = tableCells(line.text);
    if (cells === null) {
      columns = null;
      const item = /^\s*(\d+)\.\s+(.+)$/.exec(line.text);
      if (item) {
        const [label, evidence = ""] = item[2]!.split(/\s*Evidence:\s*/i, 2);
        rows.push({
          label: `${item[1]}. ${label!.trim()}`,
          status: headingStatus,
          evidence: evidence.trim(),
          by: evidenceBy(null, evidence),
        });
      }
      continue;
    }
    if (columns === null) {
      const find = (pattern: RegExp) => cells.findIndex((cell) => pattern.test(cell));
      const label = find(/criteri|기준/i);
      const result = find(/result|status|결과/i);
      columns =
        label === -1 || result === -1
          ? { label: -1, result: -1, evidence: -1, by: -1 }
          : { label, result, evidence: find(/evidence|증거|proof/i), by: find(/^by$|누가/i) };
      continue;
    }
    if (columns.label === -1 || isSeparatorRow(cells)) continue;
    const evidence = columns.evidence === -1 ? "" : (cells[columns.evidence] ?? "");
    rows.push({
      label: cells[columns.label] ?? "",
      status: resultStatus(cells[columns.result] ?? ""),
      evidence,
      by: evidenceBy(columns.by === -1 ? null : (cells[columns.by] ?? ""), evidence),
    });
  }
  return rows;
};

const RESOLVED = /\b(resolved|fixed|accepted|won['’]?t fix|dropped)\b|해결/i;

export const parseReview = (text: string): ReadonlyArray<NodeReviewFinding> => {
  const findings = new Map<string, boolean>();
  let columns: { id: number; status: number } | null = null;
  for (const line of toLines(text)) {
    if (line.inFence) continue;
    const cells = tableCells(line.text);
    if (cells === null) {
      columns = null;
      const bullet = /^\s*-\s+([A-Z]{1,3}\d+)\b(.*)$/.exec(line.text);
      if (bullet) findings.set(bullet[1]!, RESOLVED.test(bullet[2]!));
      continue;
    }
    if (columns === null) {
      columns = {
        id: cells.findIndex((cell) => /^id$/i.test(cell)),
        status: cells.findIndex((cell) => /^status$/i.test(cell)),
      };
      continue;
    }
    if (columns.id === -1 || isSeparatorRow(cells)) continue;
    const id = cells[columns.id] ?? "";
    if (/^[A-Z]{1,3}\d+$/.test(id)) {
      findings.set(id, columns.status !== -1 && RESOLVED.test(cells[columns.status] ?? ""));
    }
  }
  return [...findings].map(([id, resolved]) => ({ id, resolved }));
};

const readText = (
  files: RecordFiles,
  name: RecordFileName,
  issues: Array<NodeIssue>,
): string | null => {
  const content = files[name];
  if (content === undefined) return null;
  if (typeof content === "string") return content;
  issues.push({
    kind: "unreadable_file",
    file: name,
    message: `파일을 읽지 못했습니다: ${content.error}`,
  });
  return null;
};

/** Turns one `.jwn/<task>/` folder into a contract, its state and everything that failed to read. */
export const parseRecord = (id: string, files: RecordFiles): ParsedRecord => {
  const issues: Array<NodeIssue> = [];
  const alignText = readText(files, "ALIGN.md", issues);
  const statusText = readText(files, "STATUS.md", issues);
  const verifyText = readText(files, "VERIFY.md", issues);
  const reviewText = readText(files, "REVIEW.md", issues);

  let contract: NodeContract | null = null;
  if (alignText !== null) {
    const parsed = parseAlign(id, alignText);
    contract = parsed.contract;
    issues.push(...parsed.issues);
  } else if (files["ALIGN.md"] === undefined) {
    issues.push({
      kind: "missing_contract",
      file: "ALIGN.md",
      message: "ALIGN.md가 없어 합의된 끝 상태(기준)를 알 수 없습니다. 진행도는 계산하지 않습니다.",
    });
  }

  const statusState = statusText === null ? "unknown" : parseStatusState(statusText);
  const state: NodeState =
    statusState === "unknown" && contract !== null && contract.approved === null
      ? "draft"
      : statusState;

  return {
    contract,
    state,
    statusText,
    verifyRows: verifyText === null ? [] : parseVerify(verifyText),
    reviewFindings: reviewText === null ? [] : parseReview(reviewText),
    issues,
  };
};
