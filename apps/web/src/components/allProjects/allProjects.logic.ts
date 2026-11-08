import type {
  EnvironmentId,
  ProjectAttentionKind,
  ProjectTaskCheck,
  ProjectTaskId,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
} from "@t3tools/contracts";

import {
  isFinishedTask,
  type TaskRelationsIndex,
  taskRelations,
} from "../task/taskRelations.logic";

/** Finished goals stay on the map, struck through, for this long. */
export const DONE_GOAL_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MapEntry {
  readonly environmentId: EnvironmentId;
  readonly summary: ProjectTeamAttentionSummary;
}

/** Where a goal is in its life: what the map sorts and colors by. */
export type GoalPhase = "active" | "waiting" | "planning" | "done";

export interface MapGoal {
  readonly task: ProjectTaskReference;
  readonly phase: GoalPhase;
  readonly checks: ReadonlyArray<ProjectTaskCheck>;
  readonly passed: number;
}

export interface MapProgress {
  readonly passed: number;
  readonly total: number;
  /** 0–100, rounded. */
  readonly percent: number;
}

export interface NeedsYou {
  readonly total: number;
  /** Such as "플랜 승인 1 · 질문 1"; empty when nothing waits. */
  readonly label: string;
  /** When the oldest open card was raised; null when nothing waits. */
  readonly oldestAt: string | null;
}

export interface MapProject {
  readonly environmentId: EnvironmentId;
  readonly summary: ProjectTeamAttentionSummary;
  /** Sorted: active, waiting, planning, done. */
  readonly goals: ReadonlyArray<MapGoal>;
  /** Null when the project has no goals. */
  readonly progress: MapProgress | null;
  readonly now: ReadonlyArray<string>;
  readonly next: ReadonlyArray<string>;
  readonly needsYou: NeedsYou;
  readonly working: boolean;
  readonly latestUpdate: string | null;
}

export interface MapGoalRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectTeamAttentionSummary["projectId"];
  readonly taskId: ProjectTaskId;
}

/** A goal in one project waiting on a goal in another. */
export interface MapArrow {
  readonly from: MapGoalRef;
  readonly to: MapGoalRef;
  readonly toGoalTitle: string;
}

const ACTIVE_STAGES = new Set<ProjectTaskReference["stage"]>(["running", "in_review"]);
const NEXT_STAGES = new Set<ProjectTaskReference["stage"]>([
  "inbox",
  "planning",
  "awaiting_approval",
]);
const PHASE_ORDER: Record<GoalPhase, number> = { active: 0, waiting: 1, planning: 2, done: 3 };

const NEEDS_YOU_LABELS: Partial<Record<ProjectAttentionKind, string>> = {
  approval: "플랜 승인",
  decision: "질문",
  blocker: "막힘",
  proposal: "제안",
};
/** Card kinds this app version doesn't know yet still count. */
const OTHER_CARD_LABEL = "카드";

/**
 * A goal is a top-level task in its project: no parent, or a parent in another project
 * (a Director epic's subtask).
 */
export function isTopLevelTask(
  task: Pick<ProjectTaskReference, "parentTaskId">,
  projectTaskIds: ReadonlySet<ProjectTaskId>,
): boolean {
  return task.parentTaskId === null || !projectTaskIds.has(task.parentTaskId);
}

function goalPhase(task: ProjectTaskReference, checks: ReadonlyArray<ProjectTaskCheck>): GoalPhase {
  if (task.stage === "done") return "done";
  if (ACTIVE_STAGES.has(task.stage)) return "active";
  return checks.length === 0 ? "planning" : "waiting";
}

/**
 * A project's goals: its top-level tasks, without proposals, cancelled ones and ones that
 * finished more than a week ago. In progress first, then waiting, planning and done.
 */
export function selectGoals(
  tasks: ReadonlyArray<ProjectTaskReference>,
  nowMs: number,
): ReadonlyArray<MapGoal> {
  const ids = new Set(tasks.map((task) => task.id));
  return tasks
    .filter((task) => isTopLevelTask(task, ids))
    .filter((task) => {
      // A proposal is not a goal until the user adds it.
      if (task.stage === "cancelled" || task.stage === "proposed") return false;
      if (task.stage !== "done") return true;
      if (task.updatedAt === null) return false;
      return nowMs - Date.parse(task.updatedAt) <= DONE_GOAL_VISIBLE_MS;
    })
    .map((task) => {
      const checks = task.checks ?? [];
      return {
        task,
        checks,
        phase: goalPhase(task, checks),
        passed: checks.filter((check) => check.passed).length,
      };
    })
    .toSorted(
      (a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.task.number - b.task.number,
    );
}

/**
 * Checks passed over all checks of the goals. A goal still being planned has no checks
 * yet, so it adds nothing to either side. Null when there are no goals.
 */
export function goalProgress(goals: ReadonlyArray<MapGoal>): MapProgress | null {
  if (goals.length === 0) return null;
  let passed = 0;
  let total = 0;
  for (const goal of goals) {
    passed += goal.passed;
    total += goal.checks.length;
  }
  return { passed, total, percent: total === 0 ? 0 : Math.round((passed / total) * 100) };
}

/** Open cards waiting on the user, counted by kind. */
export function needsYouOf(summary: Pick<ProjectTeamAttentionSummary, "decisionCards">): NeedsYou {
  const open = summary.decisionCards.filter(
    (card) => card.item.answeredAt === null && card.item.supersededAt === null,
  );
  const counts = new Map<string, number>();
  for (const card of open) {
    const label = NEEDS_YOU_LABELS[card.item.kind] ?? OTHER_CARD_LABEL;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const order = [...Object.values(NEEDS_YOU_LABELS), OTHER_CARD_LABEL];
  const label = order
    .filter((name) => counts.has(name))
    .map((name) => `${name} ${counts.get(name)}`)
    .join(" · ");
  const oldestAt = open.reduce<string | null>(
    (oldest, card) =>
      oldest === null || card.item.createdAt < oldest ? card.item.createdAt : oldest,
    null,
  );
  return { total: open.length, label, oldestAt };
}

function latestUpdateOf(tasks: ReadonlyArray<ProjectTaskReference>): string | null {
  return tasks.reduce<string | null>(
    (latest, task) =>
      task.updatedAt !== null && (latest === null || task.updatedAt > latest)
        ? task.updatedAt
        : latest,
    null,
  );
}

function rank(project: MapProject): number {
  if (project.needsYou.total > 0) return 0;
  return project.working ? 1 : 2;
}

/**
 * One map card per project: projects waiting on the user first, then ones at work,
 * then the rest; most recently active first within each.
 */
export function buildProjectMap(
  entries: ReadonlyArray<MapEntry>,
  nowMs: number,
): ReadonlyArray<MapProject> {
  return entries
    .map(({ environmentId, summary }): MapProject => {
      const goals = selectGoals(summary.tasks, nowMs);
      return {
        environmentId,
        summary,
        goals,
        progress: goalProgress(goals),
        now: goals.filter((goal) => ACTIVE_STAGES.has(goal.task.stage)).map((g) => g.task.title),
        next: goals.filter((goal) => NEXT_STAGES.has(goal.task.stage)).map((g) => g.task.title),
        needsYou: needsYouOf(summary),
        working: summary.presence.running > 0 || goals.some((goal) => goal.phase === "active"),
        latestUpdate: latestUpdateOf(summary.tasks),
      };
    })
    .toSorted((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (a.latestUpdate === b.latestUpdate) return 0;
      if (a.latestUpdate === null) return 1;
      if (b.latestUpdate === null) return -1;
      return a.latestUpdate > b.latestUpdate ? -1 : 1;
    });
}

/** The top-level task a task belongs to in its own project. */
function goalOf(
  task: ProjectTaskReference,
  byId: ReadonlyMap<ProjectTaskId, ProjectTaskReference>,
): ProjectTaskReference {
  let current = task;
  const seen = new Set<ProjectTaskId>();
  while (current.parentTaskId !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentTaskId);
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}

/** Project IDs are unique per environment; the map keys cards and arrow ends by both. */
export function projectKey(environmentId: EnvironmentId, projectId: string): string {
  // Printable, so it can sit in a data attribute and a CSS selector.
  return `${environmentId}/${projectId}`;
}

/**
 * Dependencies between projects, one per pair of goals: an open task in one project waits
 * on an open task in another. Both ends are the goals on the map that hold those tasks.
 */
export function buildMapArrows(
  projects: ReadonlyArray<MapProject>,
  relations: TaskRelationsIndex,
): ReadonlyArray<MapArrow> {
  const tasksByProject = new Map<string, Map<ProjectTaskId, ProjectTaskReference>>();
  const shownGoals = new Set<string>();
  for (const project of projects) {
    const key = projectKey(project.environmentId, project.summary.projectId);
    tasksByProject.set(key, new Map(project.summary.tasks.map((task) => [task.id, task])));
    for (const goal of project.goals) shownGoals.add(`${key}\u0000${goal.task.id}`);
  }
  const arrows: MapArrow[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const { environmentId } = project;
    const fromKey = projectKey(environmentId, project.summary.projectId);
    const fromTasks = tasksByProject.get(fromKey)!;
    for (const task of project.summary.tasks) {
      // A proposal the user hasn't added is no dependency yet, on either end.
      if (isFinishedTask(task) || task.stage === "proposed") continue;
      for (const blocker of taskRelations(relations, environmentId, task.id).blockedBy) {
        if (blocker.projectId === project.summary.projectId) continue;
        if (blocker.task.stage === "proposed") continue;
        const toKey = projectKey(blocker.environmentId, blocker.projectId);
        const toTasks = tasksByProject.get(toKey);
        if (toTasks === undefined) continue;
        const fromGoal = goalOf(task, fromTasks);
        const toGoal = goalOf(blocker.task, toTasks);
        if (
          !shownGoals.has(`${fromKey}\u0000${fromGoal.id}`) ||
          !shownGoals.has(`${toKey}\u0000${toGoal.id}`)
        ) {
          continue;
        }
        const id = `${fromKey}\u0000${fromGoal.id}\u0000${toKey}\u0000${toGoal.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        arrows.push({
          from: { environmentId, projectId: project.summary.projectId, taskId: fromGoal.id },
          to: {
            environmentId: blocker.environmentId,
            projectId: blocker.projectId,
            taskId: toGoal.id,
          },
          toGoalTitle: toGoal.title,
        });
      }
    }
  }
  return arrows;
}

/** The PM chat to open from "나를 기다림": the one whose open card has waited longest. */
export function longestWaiting<T extends { readonly needsYou: NeedsYou }>(
  candidates: ReadonlyArray<T>,
): T | null {
  let found: T | null = null;
  for (const candidate of candidates) {
    const at = candidate.needsYou.oldestAt;
    if (at === null) continue;
    if (found === null || at < found.needsYou.oldestAt!) found = candidate;
  }
  return found;
}
