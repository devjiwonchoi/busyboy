import {
  fitTransform,
  GOAL_MAP_LAYOUT,
  zoomToGoal,
  type GoalMapLayout,
  type GoalMapNextAction,
  type GoalMapTask,
  type GoalMapTransform,
} from "@t3tools/shared/goalMap";

/** Root stack route of the All projects goal map; Stack.tsx registers it under this name. */
export const GOAL_MAP_ROUTE = "GoalMap" as const;
export const GOAL_MAP_LINKING_PATH = "all-projects";
export const GOAL_MAP_TITLE = "전체 프로젝트";

/** The whole map, or one goal's cell. */
export type GoalMapZoom = { kind: "all" } | { kind: "goal"; goalId: string };
export const GOAL_MAP_ZOOM_ALL: GoalMapZoom = { kind: "all" };

/** Map-to-screen transform for a zoom state: the goal's cell, or the whole map. */
export function goalMapTransform(
  layout: GoalMapLayout,
  zoom: GoalMapZoom,
  viewport: { width: number; height: number },
): GoalMapTransform {
  return zoom.kind === "goal"
    ? zoomToGoal(layout, zoom.goalId, viewport)
    : fitTransform(layout, viewport);
}

/**
 * A task opens its lead thread. The mobile app has no task screen, so a task without a
 * lead thread is not pressable.
 */
export function goalMapThreadTarget(
  task: Pick<GoalMapTask, "environmentId" | "leadThreadId">,
): {
  environmentId: GoalMapTask["environmentId"];
  id: NonNullable<GoalMapTask["leadThreadId"]>;
} | null {
  return task.leadThreadId === null
    ? null
    : { environmentId: task.environmentId, id: task.leadThreadId };
}

/** Smallest on-screen size, in points, of the goal text and task labels. */
export const GOAL_MAP_MIN_TEXT_PT = 10;
/** Font size of a task's key label, in map units. */
export const GOAL_MAP_TASK_LABEL_SIZE = 11;

/**
 * The goal text block at text scale 1, in map units: a title line, a counts line and the
 * next action. The lines add up to GOAL_MAP_LAYOUT.textHeight.
 */
const GOAL_TEXT = {
  titleSize: 16,
  titleLine: 20,
  countsGap: 2,
  smallSize: 12,
  smallLine: 16,
  actionGap: 4,
  actionHeight: 22,
  actionPad: 6,
} as const;

export type GoalTextMetrics = { [K in keyof typeof GOAL_TEXT]: number } & { height: number };

/**
 * How much to scale the goal text block up so its smallest text is at least
 * GOAL_MAP_MIN_TEXT_PT on screen when the map is drawn at `mapScale` points per map unit.
 * Never shrinks it, and never grows it past the bottom of the goal's cell.
 */
export function goalTextScale(mapScale: number): number {
  const L = GOAL_MAP_LAYOUT;
  const max = (L.cellHeight - L.textTop) / L.textHeight;
  const wanted = mapScale > 0 ? GOAL_MAP_MIN_TEXT_PT / (GOAL_TEXT.smallSize * mapScale) : 1;
  return Math.min(max, Math.max(1, wanted));
}

/** Font sizes, line heights and gaps of the goal text block scaled by `k`. */
export function goalTextMetrics(k: number): GoalTextMetrics {
  const scaled = Object.fromEntries(
    Object.entries(GOAL_TEXT).map(([key, value]) => [key, value * k]),
  ) as { [K in keyof typeof GOAL_TEXT]: number };
  return {
    ...scaled,
    height:
      scaled.titleLine +
      scaled.countsGap +
      scaled.smallLine +
      scaled.actionGap +
      scaled.actionHeight,
  };
}

/**
 * Task labels show once a goal is zoomed, or when the whole map is already large enough to
 * read them; the phone overview draws the circles alone.
 */
export function showGoalMapTaskLabels(zoom: GoalMapZoom, mapScale: number): boolean {
  return zoom.kind === "goal" || GOAL_MAP_TASK_LABEL_SIZE * mapScale >= GOAL_MAP_MIN_TEXT_PT;
}

const NEXT_ACTION_LEAD: Record<GoalMapNextAction["kind"], string> = {
  user: "내 차례",
  running: "진행 중",
  blocked: "막힘",
  waiting: "대기",
  none: "남은 일 없음",
};

/** The next action for the overview's scaled-up text: its kind and task key only. */
export function compactNextAction(nextAction: GoalMapNextAction): string {
  const lead = NEXT_ACTION_LEAD[nextAction.kind];
  return nextAction.task === null ? lead : `${lead} ${nextAction.task.key}`;
}
