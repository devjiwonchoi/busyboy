/**
 * The All projects goal map: one node per active workspace goal, its open tasks around it
 * and its finished work as dots. Shared by the web and mobile apps so both draw the same
 * data with the same fixed layout.
 */

import {
  formatTaskKey,
  isSnoozedAttention,
  resolveProjectTaskStatus,
  type EnvironmentId,
  type ProjectDecisionCard,
  type ProjectId,
  type ProjectTaskId,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { alignWorkspaceGoals } from "./workspaceGoals.js";

/** One manager's snapshot in one environment. */
export type GoalMapEntry = { environmentId: EnvironmentId; summary: ProjectTeamAttentionSummary };

/** What the user has to do for a task: the card kind and its short label. */
export type GoalMapUserTurn = {
  kind: "approval" | "decision" | "blocker" | "question";
  label: "승인" | "결정" | "조치" | "답변";
};

/** An open task drawn around its goal. */
export type GoalMapTask = {
  /** `task:${environmentId}/${taskId}`, unique across environments. */
  nodeId: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  taskId: ProjectTaskId;
  key: string;
  title: string;
  /** The title cut to 14 characters plus "…". */
  shortTitle: string;
  /** user: waits on the user; blocked: blocked, failed or waiting on unfinished work. */
  status: "running" | "user" | "blocked" | "waiting";
  userTurn: GoalMapUserTurn | null;
  parentKey: string | null;
  /** Keys of the unfinished tasks this one waits on. */
  waitsOnKeys: string[];
  leadThreadId: ThreadId | null;
  pmThreadId: ThreadId;
};

export type GoalMapNextAction = {
  kind: "user" | "running" | "blocked" | "waiting" | "none";
  text: string;
  task: GoalMapTask | null;
  /** Other open tasks of the same kind. */
  more: number;
};

/**
 * An active goal, or the trailing "goal:none" for open work no goal covers. Counts and the
 * next action cover every task serving the goal; a task serving several goals is drawn
 * only under the first, so `tasks` lists the nodes placed in this goal's cell.
 */
export type GoalMapGoal = {
  id: string;
  title: string;
  none: boolean;
  /** blocked includes the user's turn, failed runs and waiting on unfinished work. */
  counts: { remaining: number; done: number; inProgress: number; waiting: number; blocked: number };
  nextAction: GoalMapNextAction;
  /** Placed open tasks: user turn, running, blocked, waiting, then task number. */
  tasks: GoalMapTask[];
  /** Open tasks of this cell that did not fit, shown as "+N". */
  overflow: number;
  doneCount: number;
  /** Done tasks beyond the dot cap. */
  hiddenDone: number;
};

/** A dashed arrow from a task to an unfinished task it waits on. */
export type GoalMapEdge = { id: string; fromTaskNodeId: string; toTaskNodeId: string };

export type GoalMapCircle = { x: number; y: number; r: number };
export type GoalMapRect = { x: number; y: number; width: number; height: number };

/** Map coordinates; the renderer scales them with fitTransform or zoomToGoal. */
export type GoalMapLayout = {
  width: number;
  height: number;
  cells: Record<string, GoalMapRect>;
  goalPos: Record<string, GoalMapCircle>;
  /** `r` is the drawn circle; circles keep GOAL_MAP_LAYOUT.taskHitRadius apart. */
  taskPos: Record<string, GoalMapCircle>;
  dotPos: Record<string, GoalMapCircle[]>;
  /** The goal's title, counts and next action, right under the goal circle. */
  textPos: Record<string, GoalMapRect>;
  /** Where "+N" goes for open tasks that did not fit, under the outer arc. */
  overflowPos: Record<string, { x: number; y: number }>;
};

export type GoalMap = {
  briefing: string | null;
  director: GoalMapEntry | null;
  goals: GoalMapGoal[];
  edges: GoalMapEdge[];
  layout: GoalMapLayout;
};

/** A transform from map to screen coordinates: screen = map * scale + (x, y). */
export type GoalMapTransform = { scale: number; x: number; y: number };

/** Fixed layout sizes, exported so renderers can place labels in the same cells. */
export const GOAL_MAP_LAYOUT = {
  cellWidth: 440,
  cellHeight: 250,
  columns: 2,
  /** Goal center within its cell: top left, with its text block right under it. */
  goalX: 56,
  goalY: 66,
  goalRadius: 28,
  taskRadius: 13,
  /** A task circle's spacing radius; labels sit beside it, toward the cell's right edge. */
  taskHitRadius: 22,
  /**
   * Open tasks fill rows to the right of the goal, alternating between two gentle arcs
   * around it (even rows on the inner arc), so each label runs to the cell edge between
   * the other arc's circles.
   */
  taskRows: 9,
  taskTop: 26,
  taskRowStep: 24,
  arcX: [252, 298],
  /** How far an arc bends back toward the goal at the bottom row. */
  arcBend: 14,
  dotRadius: 2.5,
  dotArcRadius: 38,
  maxDots: 16,
  /** The per-goal text (title, counts, next action), relative to the cell, under the goal. */
  textLeft: 12,
  textTop: 102,
  textWidth: 208,
  textHeight: 64,
} as const;

const USER_TURN: Record<GoalMapUserTurn["kind"], GoalMapUserTurn> = {
  approval: { kind: "approval", label: "승인" },
  decision: { kind: "decision", label: "결정" },
  blocker: { kind: "blocker", label: "조치" },
  question: { kind: "question", label: "답변" },
};
const STATUS_RANK: Record<GoalMapTask["status"], number> = {
  user: 0,
  running: 1,
  blocked: 2,
  waiting: 3,
};
const NONE_GOAL = "goal:none";

const finished = (stage: string) => stage === "done" || stage === "cancelled";
const scopedKey = (environmentId: string, id: string) => `${environmentId}/${id}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// A snoozed card is the user's own pause, so its task is not waiting on them.
const openCard = (card: ProjectDecisionCard) =>
  card.item.answeredAt === null &&
  card.item.supersededAt === null &&
  !isSnoozedAttention(card.item);

function shorten(title: string): string {
  const chars = [...title];
  return chars.length > 14 ? `${chars.slice(0, 14).join("").trimEnd()}…` : title;
}

export function buildGoalMap(input: { entries: ReadonlyArray<GoalMapEntry> }): GoalMap {
  // Sort first so nothing below depends on the order entries or tasks arrive in.
  const entries = input.entries.toSorted(
    (a, b) =>
      compare(a.environmentId, b.environmentId) ||
      compare(a.summary.projectId, b.summary.projectId),
  );
  const director = entries.find((entry) => entry.summary.kind === "director") ?? null;
  const active = (director?.summary.goals ?? [])
    .filter((goal) => goal.status === "active")
    .toSorted((a, b) => a.position - b.position || compare(a.id, b.id));

  type Record_ = ProjectTaskReference & {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    entry: GoalMapEntry;
  };
  const records: Record_[] = entries.flatMap((entry) =>
    entry.summary.tasks
      .toSorted((a, b) => a.number - b.number || compare(a.id, b.id))
      .map((task) => ({
        ...task,
        environmentId: entry.environmentId,
        projectId: entry.summary.projectId,
        entry,
      })),
  );
  const byId = new Map(records.map((task) => [scopedKey(task.environmentId, task.id), task]));
  const keyOf = (task: Record_) => formatTaskKey(task.entry.summary.taskKeyPrefix, task.number);
  const lineage = (task: Record_) => {
    const chain: Record_[] = [];
    const seen = new Set<string>();
    let current: Record_ | undefined = task;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current =
        current.parentTaskId === null
          ? undefined
          : byId.get(scopedKey(current.environmentId, current.parentTaskId));
    }
    return chain;
  };

  // Recompute from the same snapshot as the nodes, so stale server alignment cannot hide work.
  const environments = [...new Set(entries.map((entry) => entry.environmentId))];
  const alignments = new Map(
    environments.map((environmentId) => [
      environmentId,
      alignWorkspaceGoals({
        goals: director?.environmentId === environmentId ? active : [],
        tasks: records.filter((task) => task.environmentId === environmentId),
        projectIds: entries
          .filter((entry) => entry.environmentId === environmentId)
          .map((entry) => entry.summary.projectId),
      }),
    ]),
  );
  const unaligned = new Set(
    [...alignments].flatMap(([environmentId, alignment]) =>
      alignment.unalignedTasks.map((task) => scopedKey(environmentId, task.taskId)),
    ),
  );
  const goalIdsOf = (task: Record_): string[] => {
    const ids: string[] = alignments
      .get(task.environmentId)!
      .goals.filter((goal) => goal.taskIds.includes(task.id))
      .map((goal) => goal.goalId);
    if (
      ids.length === 0 &&
      lineage(task).some((ancestor) => unaligned.has(scopedKey(task.environmentId, ancestor.id)))
    ) {
      ids.push(NONE_GOAL);
    }
    return ids;
  };

  const unfinishedDependencies = (task: Record_) =>
    task.waitsOn.flatMap((id) => {
      const dependency = byId.get(scopedKey(task.environmentId, id));
      return dependency !== undefined && !finished(dependency.stage) ? [dependency] : [];
    });

  const toTask = (task: Record_): GoalMapTask => {
    const card = task.entry.summary.decisionCards.find(
      (item) => openCard(item) && item.item.taskId === task.id,
    );
    const userTurn: GoalMapUserTurn | null =
      card !== undefined
        ? USER_TURN[card.item.kind]
        : task.openBlocker
          ? USER_TURN.blocker
          : task.openQuestion
            ? USER_TURN.question
            : task.stage === "awaiting_approval"
              ? USER_TURN.approval
              : null;
    const dependencies = unfinishedDependencies(task);
    const failed =
      resolveProjectTaskStatus(task, {
        openQuestion: false,
        openBlocker: false,
        leadRunning: false,
        leadFailed: false,
      }) === "fatal";
    const status: GoalMapTask["status"] =
      userTurn !== null
        ? "user"
        : task.stage === "blocked" || failed || dependencies.length > 0
          ? "blocked"
          : task.stage === "running" || task.stage === "in_review" || task.stage === "planning"
            ? "running"
            : "waiting";
    const parent =
      task.parentTaskId === null
        ? undefined
        : byId.get(scopedKey(task.environmentId, task.parentTaskId));
    return {
      nodeId: `task:${scopedKey(task.environmentId, task.id)}`,
      environmentId: task.environmentId,
      projectId: task.projectId,
      taskId: task.id,
      key: keyOf(task),
      title: task.title,
      shortTitle: shorten(task.title),
      status,
      userTurn,
      parentKey: parent === undefined ? null : keyOf(parent),
      waitsOnKeys: dependencies.map(keyOf),
      leadThreadId: task.leadThreadId,
      pmThreadId: task.entry.summary.pmThreadId,
    };
  };

  const contributing = records
    .filter((task) => task.entry.summary.kind !== "director" && task.stage !== "cancelled")
    .map((task) => ({ record: task, goalIds: goalIdsOf(task) }))
    .filter((item) => item.goalIds.length > 0);
  const openTasks = new Map(
    contributing
      .filter((item) => !finished(item.record.stage))
      .map((item) => [scopedKey(item.record.environmentId, item.record.id), toTask(item.record)]),
  );
  const sortTasks = (tasks: GoalMapTask[]) =>
    tasks.toSorted(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        byId.get(scopedKey(a.environmentId, a.taskId))!.number -
          byId.get(scopedKey(b.environmentId, b.taskId))!.number ||
        compare(a.key, b.key) ||
        compare(a.nodeId, b.nodeId),
    );

  const goalDefs: { id: string; title: string; none: boolean }[] = active.map((goal) => ({
    id: String(goal.id),
    title: goal.title,
    none: false,
  }));
  if (
    contributing.some((item) => item.goalIds.includes(NONE_GOAL) && !finished(item.record.stage))
  ) {
    goalDefs.push({ id: NONE_GOAL, title: "목표 없음", none: true });
  }
  const goalOrder = new Map(goalDefs.map((goal, index) => [goal.id, index]));
  // A task serving several goals is drawn only under the first.
  const homeGoal = (goalIds: ReadonlyArray<string>) =>
    goalIds.toSorted((a, b) => (goalOrder.get(a) ?? 0) - (goalOrder.get(b) ?? 0))[0];

  const cap = GOAL_MAP_LAYOUT.taskRows;
  const goals: GoalMapGoal[] = goalDefs.map((def) => {
    const serving = contributing.filter((item) => item.goalIds.includes(def.id));
    const open = sortTasks(
      serving
        .filter((item) => !finished(item.record.stage))
        .map((item) => openTasks.get(scopedKey(item.record.environmentId, item.record.id))!),
    );
    const doneCount = serving.filter((item) => item.record.stage === "done").length;
    const home = sortTasks(
      serving
        .filter((item) => !finished(item.record.stage) && homeGoal(item.goalIds) === def.id)
        .map((item) => openTasks.get(scopedKey(item.record.environmentId, item.record.id))!),
    );
    const count = (status: GoalMapTask["status"]) =>
      open.filter((task) => task.status === status).length;
    return {
      ...def,
      counts: {
        remaining: open.length,
        done: doneCount,
        inProgress: count("running"),
        waiting: count("waiting"),
        blocked: count("user") + count("blocked"),
      },
      nextAction: nextAction(open),
      tasks: home.slice(0, cap),
      overflow: Math.max(0, home.length - cap),
      doneCount,
      hiddenDone: Math.max(0, doneCount - GOAL_MAP_LAYOUT.maxDots),
    };
  });

  const placed = new Set(goals.flatMap((goal) => goal.tasks.map((task) => task.nodeId)));
  const edges = goals
    .flatMap((goal) => goal.tasks)
    .flatMap((task) =>
      unfinishedDependencies(byId.get(scopedKey(task.environmentId, task.taskId))!)
        .map((dependency) => `task:${scopedKey(dependency.environmentId, dependency.id)}`)
        .filter((to) => placed.has(to))
        .map((to) => ({
          id: `waits:${task.nodeId}:${to}`,
          fromTaskNodeId: task.nodeId,
          toTaskNodeId: to,
        })),
    )
    .toSorted((a, b) => compare(a.id, b.id));

  return {
    briefing: director?.summary.briefing?.trim() || null,
    director,
    goals,
    edges,
    layout: layoutGoalMap(goals),
  };
}

function nextAction(open: ReadonlyArray<GoalMapTask>): GoalMapNextAction {
  for (const kind of ["user", "running", "blocked", "waiting"] as const) {
    const tasks = open.filter((task) => task.status === kind);
    const task = tasks[0];
    if (task === undefined) {
      continue;
    }
    const more = tasks.length - 1;
    const others = more > 0 ? ` 외 ${more}개` : "";
    const text =
      kind === "user"
        ? `내 차례 · ${task.userTurn!.label} · ${task.key} ${task.shortTitle}${others}`
        : kind === "running"
          ? `진행 중 · ${task.key} ${task.shortTitle}${others}`
          : kind === "blocked"
            ? task.waitsOnKeys.length > 0
              ? `막힘 · ${task.key} (기다림: ${task.waitsOnKeys[0]})`
              : `막힘 · ${task.key}`
            : `대기 · ${task.key} ${task.shortTitle}`;
    return { kind, text, task, more };
  }
  return { kind: "none", text: "남은 일 없음", task: null, more: 0 };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Fixed grid: each goal's cell depends only on its index, never on other goals' tasks. */
function layoutGoalMap(goals: ReadonlyArray<GoalMapGoal>): GoalMapLayout {
  const L = GOAL_MAP_LAYOUT;
  const layout: GoalMapLayout = {
    width: Math.min(goals.length, L.columns) * L.cellWidth,
    height: Math.ceil(goals.length / L.columns) * L.cellHeight,
    cells: {},
    goalPos: {},
    taskPos: {},
    dotPos: {},
    textPos: {},
    overflowPos: {},
  };
  const lastRow = L.taskTop + (L.taskRows - 1) * L.taskRowStep;
  goals.forEach((goal, index) => {
    const cell = {
      x: (index % L.columns) * L.cellWidth,
      y: Math.floor(index / L.columns) * L.cellHeight,
      width: L.cellWidth,
      height: L.cellHeight,
    };
    const cx = cell.x + L.goalX;
    const cy = cell.y + L.goalY;
    layout.cells[goal.id] = cell;
    layout.goalPos[goal.id] = { x: cx, y: cy, r: L.goalRadius };
    layout.textPos[goal.id] = {
      x: cell.x + L.textLeft,
      y: cell.y + L.textTop,
      width: L.textWidth,
      height: L.textHeight,
    };
    layout.overflowPos[goal.id] = {
      x: cell.x + L.arcX[1],
      y: cell.y + lastRow + L.taskHitRadius / 2,
    };

    // Row by row from the top, alternating arcs; both bend back a little away from the goal.
    goal.tasks.forEach((task, row) => {
      const y = L.taskTop + row * L.taskRowStep;
      const reach = (y - L.goalY) / (lastRow - L.goalY);
      layout.taskPos[task.nodeId] = {
        x: round(cell.x + L.arcX[row % 2]! - L.arcBend * reach * reach),
        y: cell.y + y,
        r: L.taskRadius,
      };
    });

    // Done dots on a half circle above the goal.
    const dots = Math.min(goal.doneCount, L.maxDots);
    const span = Math.PI / (L.maxDots - 1);
    layout.dotPos[goal.id] = Array.from({ length: dots }, (_, i) => {
      const angle = -Math.PI / 2 + (i - (dots - 1) / 2) * span;
      return {
        x: round(cx + L.dotArcRadius * Math.cos(angle)),
        y: round(cy + L.dotArcRadius * Math.sin(angle)),
        r: L.dotRadius,
      };
    });
  });
  return layout;
}

/** Scales and centers `bounds` inside `viewport`, leaving `padding` on every side. */
export function fitTransform(
  bounds: { width: number; height: number },
  viewport: { width: number; height: number },
  padding = 16,
): GoalMapTransform {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale =
    bounds.width <= 0 || bounds.height <= 0
      ? 1
      : Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  return {
    scale,
    x: (viewport.width - bounds.width * scale) / 2,
    y: (viewport.height - bounds.height * scale) / 2,
  };
}

/** Fits one goal's cell to the viewport; the whole map when the goal is not on it. */
export function zoomToGoal(
  layout: GoalMapLayout,
  goalId: string,
  viewport: { width: number; height: number },
): GoalMapTransform {
  const cell = layout.cells[goalId];
  if (cell === undefined) {
    return fitTransform(layout, viewport);
  }
  const fit = fitTransform(cell, viewport);
  return { scale: fit.scale, x: fit.x - cell.x * fit.scale, y: fit.y - cell.y * fit.scale };
}
