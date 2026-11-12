import { readFileSync } from "node:fs";

import {
  fitTransform,
  GOAL_MAP_LAYOUT,
  zoomToGoal,
  type GoalMapLayout,
} from "@t3tools/shared/goalMap";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import { createSidebarHeaderItems } from "../threads/sidebar-native-header-items";
import {
  compactNextAction,
  GOAL_MAP_LINKING_PATH,
  GOAL_MAP_MIN_TEXT_PT,
  GOAL_MAP_ROUTE,
  GOAL_MAP_TASK_LABEL_SIZE,
  GOAL_MAP_ZOOM_ALL,
  goalMapThreadTarget,
  goalMapTransform,
  goalTextMetrics,
  goalTextScale,
  showGoalMapTaskLabels,
} from "./goal-map";

const layout: GoalMapLayout = {
  width: GOAL_MAP_LAYOUT.cellWidth * 2,
  height: GOAL_MAP_LAYOUT.cellHeight * 2,
  cells: {
    a: { x: 0, y: 0, width: 440, height: 250 },
    b: { x: 440, y: 0, width: 440, height: 250 },
    c: { x: 0, y: 250, width: 440, height: 250 },
  },
  goalPos: {},
  taskPos: {},
  dotPos: {},
  textPos: {},
  overflowPos: {},
};
const viewport = { width: 390, height: 600 };

describe("goal map navigation", () => {
  it("opens a task's lead thread in its own environment", () => {
    expect(
      goalMapThreadTarget({ environmentId: "env-2" as never, leadThreadId: "lead" as never }),
    ).toEqual({ environmentId: "env-2", id: "lead" });
  });

  it("leaves a task without a lead thread unpressable", () => {
    expect(goalMapThreadTarget({ environmentId: "env" as never, leadThreadId: null })).toBe(null);
  });
});

describe("goal map zoom", () => {
  it("zooms a goal to its cell", () => {
    const transform = goalMapTransform(layout, { kind: "goal", goalId: "c" }, viewport);
    expect(transform).toEqual(zoomToGoal(layout, "c", viewport));
    expect(transform).not.toEqual(fitTransform(layout, viewport));
  });

  it("fits the whole map for 전체 보기", () => {
    expect(goalMapTransform(layout, GOAL_MAP_ZOOM_ALL, viewport)).toEqual(
      fitTransform(layout, viewport),
    );
  });
});

describe("goal map text on a phone", () => {
  const L = GOAL_MAP_LAYOUT;
  // Five goals in three rows on a ~390pt phone, as the overview fits them.
  const phone = { width: 390, height: 700 };
  const fiveGoals = {
    width: L.cellWidth * L.columns,
    height: L.cellHeight * 3,
  };
  const overviewScale = fitTransform(fiveGoals, phone).scale;

  it("fits the unscaled text block in the layout's reserved height", () => {
    expect(goalTextMetrics(1).height).toBeLessThanOrEqual(L.textHeight);
  });

  it("scales the overview text up to a readable size without leaving the goal's cell", () => {
    expect(overviewScale).toBeLessThan(0.45);
    const k = goalTextScale(overviewScale);
    const m = goalTextMetrics(k);
    expect(m.smallSize * overviewScale).toBeGreaterThanOrEqual(GOAL_MAP_MIN_TEXT_PT - 1e-9);
    expect(m.titleSize * overviewScale).toBeGreaterThan(m.smallSize * overviewScale);
    expect(L.textTop + m.height).toBeLessThanOrEqual(L.cellHeight);
  });

  it("never shrinks the text, and caps it at the cell's bottom on tiny screens", () => {
    expect(goalTextScale(2)).toBe(1);
    expect(goalTextScale(0.05)).toBeCloseTo((L.cellHeight - L.textTop) / L.textHeight);
    expect(L.textTop + goalTextMetrics(goalTextScale(0.05)).height).toBeLessThanOrEqual(
      L.cellHeight + 1e-9,
    );
  });

  it("hides task labels in the phone overview and shows them once a goal is zoomed", () => {
    expect(showGoalMapTaskLabels(GOAL_MAP_ZOOM_ALL, overviewScale)).toBe(false);
    const zoomed = goalMapTransform(layout, { kind: "goal", goalId: "a" }, phone).scale;
    expect(showGoalMapTaskLabels({ kind: "goal", goalId: "a" }, zoomed)).toBe(true);
    // A map already drawn large enough keeps them.
    expect(
      showGoalMapTaskLabels(GOAL_MAP_ZOOM_ALL, GOAL_MAP_MIN_TEXT_PT / GOAL_MAP_TASK_LABEL_SIZE),
    ).toBe(true);
  });

  it("shortens the overview's next action to its kind and task key", () => {
    const task = { key: "BB-12" } as never;
    expect(
      compactNextAction({ kind: "user", text: "내 차례 · 승인 · BB-12 긴 제목", task, more: 0 }),
    ).toBe("내 차례 BB-12");
    expect(compactNextAction({ kind: "none", text: "남은 일 없음", task: null, more: 0 })).toBe(
      "남은 일 없음",
    );
  });
});

describe("goal map entry points", () => {
  it("registers the route in the root stack under the exported name", () => {
    expect(GOAL_MAP_ROUTE).toBe("GoalMap");
    expect(GOAL_MAP_LINKING_PATH).toBe("all-projects");
    // Stack.tsx pulls in native modules, so check its registration by source.
    const stack = readFileSync(new URL("../../Stack.tsx", import.meta.url), "utf8");
    expect(stack).toMatch(
      /\[GOAL_MAP_ROUTE\]: createNativeStackScreen\(\{\s*screen: GoalMapScreen,\s*linking: GOAL_MAP_LINKING_PATH,/,
    );
  });

  it("puts 전체 프로젝트 in the header menu only, not the thread filter", () => {
    const filterMenu = buildHomeListFilterMenu({
      environments: [],
      projects: [],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
    });
    const onOpenGoalMap = vi.fn();
    const items = createSidebarHeaderItems({
      filterIcon: "line.3.horizontal.decrease.circle",
      filterMenu,
      onOpenSettings: vi.fn(),
      onOpenGoalMap,
    });
    const labels = JSON.stringify(items).match(/전체 프로젝트/g) ?? [];
    expect(labels).toHaveLength(1);
    const menu = items[1];
    if (menu?.type !== "menu") throw new Error("Expected the ellipsis menu");
    const entry = menu.menu.items.find(
      (item) => item.type === "action" && item.label === "전체 프로젝트",
    );
    if (entry?.type !== "action") throw new Error("Expected the goal map action");
    entry.onPress();
    expect(onOpenGoalMap).toHaveBeenCalledOnce();
  });
});
