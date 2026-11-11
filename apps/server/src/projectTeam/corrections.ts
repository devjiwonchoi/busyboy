import {
  PLAN_CHANGES_REQUESTED,
  PROJECT_CORRECTION_STAGES,
  type IsoDateTime,
  type ProjectCorrection,
  type ProjectCorrectionKind,
  type ProjectCorrectionRate,
  type ProjectCorrectionRates,
  type ProjectCorrectionRepeat,
  type ProjectCorrectionReportEntry,
  type ProjectCorrectionStage,
  type ProjectId,
  type ProjectTaskId,
  type ProjectTaskStage,
  type ProjectTeamCorrectionsReport,
  type ProjectWorkKind,
} from "@t3tools/contracts";

import { isoFromMillis } from "./common.ts";

/** Collapses whitespace to single spaces and clips to `max` characters. */
export function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A short stable hash (FNV-1a, 8 hex digits), for dedupe keys. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const isReleaseFile = (path: string) =>
  path.startsWith(".github/workflows/") || /(^|\/)scripts\/[^/]*release[^/]*$/i.test(path);
const isUiFile = (path: string) =>
  path.startsWith("apps/web/") || path.startsWith("apps/mobile/") || path.endsWith(".tsx");
const isServerFile = (path: string) =>
  path.startsWith("apps/server/") || path.startsWith("packages/");
const isDocsFile = (path: string) =>
  path.endsWith(".md") || path.startsWith("docs/") || path.includes("/docs/");

/**
 * True when a plan answer only approves, such as "다 승인" relayed by the PM. Such an
 * answer is not a correction even though it is not the card's own approve option.
 */
export function isPlainApproval(answer: string): boolean {
  const words = answer
    .trim()
    .toLowerCase()
    .replace(/[.,!?~]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0 || words.length > 6) return false;
  return (
    words.every((word) => APPROVAL_WORD.test(word)) && words.some((word) => GO_WORD.test(word))
  );
}

// An approval or go word with an optional polite ending, such as 승인해줘 or 진행해주세요.
const GO_STEM = "승인|진행|시작|좋|오케이|ok(?:ay)?|ㅇㅋ|lgtm|yes|go|approve[ds]?|start|ㄱ+|고고";
const ENDING =
  "(?:해|해요|해줘|해줘요|해주세요|합니다|할게요|하세요|하자|요|아|아요|습니다|네요|ㄱ+)?";
const GO_WORD = new RegExp(`^(?:${GO_STEM})${ENDING}$`);
const APPROVAL_WORD = new RegExp(
  `^(?:(?:${GO_STEM})${ENDING}|다|모두|전부|그대로|이대로|and|그럼|네|응|ㅇㅇ)$`,
);

/**
 * True when a PM scope note reads as the user turning the work around ("그게 아니라",
 * "말고", "instead") rather than adding to it. Used only to fill old records.
 */
export function isDirectionChangeNote(note: string): boolean {
  if (/AFK|자리를 비웠/i.test(note)) return false;
  return /아니라|아니고|아니야|아니에요|말고|대신|정정|잘못|되돌|취소|빼(?:고|요|줘|주세요)|instead|not what|wrong|revert|undo/i.test(
    note,
  );
}

/** What kind of work a task is, from its title, request and planned files. */
export function classifyWorkKind(input: {
  readonly title: string;
  readonly request: string;
  readonly files: ReadonlyArray<string>;
}): ProjectWorkKind {
  const files = input.files.map((file) => file.trim().replace(/^\.\//, ""));
  if (
    files.some(isReleaseFile) ||
    // Only the title: requests often quote standing rules that mention releases.
    /release|릴리스|릴리즈/i.test(input.title)
  ) {
    return "release";
  }
  if (files.some(isUiFile) || /\bUI\b|화면/i.test(input.title)) return "ui";
  if (files.some(isServerFile)) return "server";
  if ((files.length > 0 && files.every(isDocsFile)) || /문서|\bdocs?\b/i.test(input.title)) {
    return "docs";
  }
  return "other";
}

/**
 * One line from plan feedback: the first inline comment, else the overall note, else the
 * first line of text after the "Request changes" header.
 */
export function planFeedbackLine(answer: string): string {
  const lines = answer.split("\n");
  if (lines[0]?.trim().startsWith(PLAN_CHANGES_REQUESTED)) lines.shift();
  const comment = lines.find((line) => /^\d+\.\s+\[[^\]]*\]\s+"/.test(line.trim()));
  if (comment !== undefined) {
    return oneLine(comment.trim().replace(/^\d+\.\s+\[[^\]]*\]\s+/, ""));
  }
  const overallAt = lines.findIndex((line) => line.trim() === "Overall:");
  if (overallAt !== -1) {
    const note = lines
      .slice(overallAt + 1)
      .find((line) => line.trim().length > 0 && line.trim() !== "Inline comments:");
    if (note !== undefined) return oneLine(note);
  }
  const first = lines.find((line) => line.trim().length > 0 && line.trim() !== "Inline comments:");
  return oneLine(first ?? "");
}

export interface RevertCommit {
  readonly sha: string;
  readonly prNumber: number;
  readonly subject: string;
  /** Commit time in ISO 8601, or null when the log line has none. */
  readonly committedAt: string | null;
}

/**
 * Revert commits in `git log --format=%H%x1f%cI%x1f%s%x1f%b%x1e` output, with the number of the
 * pull request each one reverted. Reverts whose pull request can't be told are left out,
 * and so are reverts of reverts, which bring the work back.
 */
export function parseRevertCommits(gitLog: string): ReadonlyArray<RevertCommit> {
  const commits: Array<RevertCommit> = [];
  for (const record of gitLog.split("\x1e")) {
    const [rawSha, rawDate, rawSubject, body = ""] = record.split("\x1f");
    const sha = rawSha?.trim() ?? "";
    const subject = rawSubject?.trim() ?? "";
    if (sha.length === 0) continue;
    const quoted = subject.startsWith('Revert "');
    if (!quoted && !body.includes("This reverts commit")) continue;
    const reverted = quoted ? subject.slice('Revert "'.length, subject.lastIndexOf('"')) : "";
    if (reverted.startsWith('Revert "')) continue;
    const fromSubject = [...reverted.matchAll(/\(#(\d+)\)/g)].at(-1)?.[1];
    const fromBody = /^Reverts\s+[\w.-]+\/[\w.-]+#(\d+)\s*$/m.exec(body)?.[1];
    const prNumber = Number(fromSubject ?? fromBody);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) continue;
    const time = Date.parse(rawDate?.trim() ?? "");
    const committedAt = Number.isNaN(time) ? null : isoFromMillis(time);
    commits.push({ sha, prNumber, subject, committedAt });
  }
  return commits;
}

/** A task as the report needs it. */
export interface CorrectionReportTask {
  readonly id: ProjectTaskId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly key: string;
  readonly title: string;
  readonly stage: ProjectTaskStage;
  readonly prUrl: string | null;
  readonly workKind: ProjectWorkKind;
  /** The user (or the PM with their words) answered at least one of its plan cards. */
  readonly planAnswered: boolean;
  readonly updatedAt: IsoDateTime;
}

const STARTED_STAGES: ReadonlySet<ProjectTaskStage> = new Set(["running", "in_review", "done"]);

/** Whether a task could have been corrected at a stage. */
function eligibleAt(task: CorrectionReportTask, stage: ProjectCorrectionStage): boolean {
  if (task.stage === "cancelled") return false;
  switch (stage) {
    case "plan":
      return task.planAnswered;
    case "running":
      return STARTED_STAGES.has(task.stage);
    case "pr":
      return task.prUrl !== null;
    case "merged":
      return task.stage === "done" && task.prUrl !== null;
  }
}

const rateOf = (
  stage: ProjectCorrectionRate["stage"],
  eligible: number,
  corrected: number,
): ProjectCorrectionRate => ({
  stage,
  eligible,
  corrected,
  passed: eligible - corrected,
  rate: eligible === 0 ? 0 : corrected / eligible,
});

/** Rates for one group of tasks and the corrections made on them. */
function ratesFor(
  tasks: ReadonlyArray<CorrectionReportTask>,
  corrections: ReadonlyArray<ProjectCorrection>,
): ReadonlyArray<ProjectCorrectionRate> {
  const rows: Array<ProjectCorrectionRate> = [];
  const anyEligible = new Set<string>();
  const anyCorrected = new Set<string>();
  for (const stage of PROJECT_CORRECTION_STAGES) {
    const corrected = new Set(
      corrections.filter((entry) => entry.stage === stage).map((entry) => entry.taskId as string),
    );
    // A corrected task always counts as eligible, so the rate stays at most 1.
    const eligible = new Set(
      tasks.filter((task) => eligibleAt(task, stage)).map((task) => task.id as string),
    );
    for (const id of corrected) eligible.add(id);
    for (const id of eligible) anyEligible.add(id);
    for (const id of corrected) anyCorrected.add(id);
    rows.push(rateOf(stage, eligible.size, corrected.size));
  }
  rows.push(rateOf("task", anyEligible.size, anyCorrected.size));
  return rows;
}

const RECENT_TEXT_MAX = 300;
const REPEAT_EXAMPLES = 5;
const SUGGEST_RULE_AT = 3;

/**
 * The Director's view of corrections. Rates count tasks touched in the window plus any
 * task corrected in it; recent and repeated use corrections made in the window; backfilled
 * counts every correction found in history, whenever it happened.
 */
export function correctionReport(input: {
  /** Every project in scope, so one with no tasks still gets a row. */
  readonly projects: ReadonlyArray<{ readonly projectId: ProjectId; readonly name: string }>;
  readonly tasks: ReadonlyArray<CorrectionReportTask>;
  /** Every correction for the projects in scope, any age. */
  readonly corrections: ReadonlyArray<ProjectCorrection>;
  readonly since: IsoDateTime;
  readonly workKind?: ProjectWorkKind | undefined;
  readonly recentLimit: number;
}): ProjectTeamCorrectionsReport {
  const sinceMs = Date.parse(input.since);
  const taskById = new Map(input.tasks.map((task) => [task.id as string, task]));
  const inScope = input.corrections.filter((entry) => taskById.has(entry.taskId));
  const windowed = inScope.filter(
    (entry) =>
      Date.parse(entry.createdAt) >= sinceMs &&
      (input.workKind === undefined || entry.workKind === input.workKind),
  );
  const correctedIds = new Set(windowed.map((entry) => entry.taskId as string));
  const tasks = input.tasks.filter(
    (task) =>
      (input.workKind === undefined || task.workKind === input.workKind) &&
      (Date.parse(task.updatedAt) >= sinceMs || correctedIds.has(task.id)),
  );

  // Rates group by the task's current work kind; the stored one only differs if the plan moved.
  const rates: Array<ProjectCorrectionRates> = [];
  for (const { projectId, name: projectName } of input.projects) {
    const projectTasks = tasks.filter((task) => task.projectId === projectId);
    const corrections = windowed.filter((entry) => entry.projectId === projectId);
    const correctionsOf = (group: ReadonlyArray<CorrectionReportTask>) => {
      const ids = new Set(group.map((task) => task.id as string));
      return corrections.filter((entry) => ids.has(entry.taskId));
    };
    rates.push({
      projectId,
      projectName,
      workKind: null,
      stages: ratesFor(projectTasks, correctionsOf(projectTasks)),
    });
    const kinds = [...new Set(projectTasks.map((task) => task.workKind))].toSorted();
    for (const workKind of kinds) {
      const group = projectTasks.filter((task) => task.workKind === workKind);
      rates.push({
        projectId,
        projectName,
        workKind,
        stages: ratesFor(group, correctionsOf(group)),
      });
    }
  }

  const recent: Array<ProjectCorrectionReportEntry> = windowed
    .toReversed()
    .slice(0, input.recentLimit)
    .map((entry) => {
      const task = taskById.get(entry.taskId)!;
      return {
        projectId: entry.projectId,
        projectName: task.projectName,
        taskId: entry.taskId,
        taskKey: task.key,
        title: task.title,
        kind: entry.kind,
        stage: entry.stage,
        workKind: entry.workKind,
        userText: oneLine(entry.userText, RECENT_TEXT_MAX),
        whatDiffered: entry.whatDiffered,
        createdAt: entry.createdAt,
        backfilled: entry.backfilled,
      };
    });

  const groups = new Map<string, Array<ProjectCorrection>>();
  for (const entry of windowed) {
    const key = `${entry.projectId}\u0000${entry.workKind}\u0000${entry.stage}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const repeated: Array<ProjectCorrectionRepeat> = [...groups.values()]
    .filter((entries) => entries.length >= 2)
    .map((entries) => {
      const first = entries[0]!;
      return {
        projectId: first.projectId,
        projectName: taskById.get(first.taskId)!.projectName,
        workKind: first.workKind,
        stage: first.stage,
        count: entries.length,
        examples: entries
          .toReversed()
          .slice(0, REPEAT_EXAMPLES)
          .map((entry) => entry.whatDiffered),
        suggestRule: entries.length >= SUGGEST_RULE_AT,
      };
    })
    .toSorted((a, b) => b.count - a.count);

  const backfilled: Record<ProjectCorrectionKind, number> = {
    plan_changes: 0,
    direction_change: 0,
    pr_change_request: 0,
    revert: 0,
  };
  for (const entry of inScope) if (entry.backfilled) backfilled[entry.kind] += 1;

  return { since: input.since, rates, recent, repeated, backfilled };
}
