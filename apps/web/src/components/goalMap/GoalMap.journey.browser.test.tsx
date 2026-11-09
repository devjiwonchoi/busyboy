import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-09T12:00" }));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => state.threads) as never,
  useProjects: (() => state.projects) as never,
  useServerConfigs: (() => new Map()) as never,
  useEnvironmentIdentities: (() => []) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => state.managers) as never,
  useEnvironmentProjectTeamAttention: (() => ({
    byProjectId: new Map(state.managers.map((m) => [m.summary.projectId, m.summary])),
    byPmThreadId: new Map(state.managers.map((m) => [m.summary.pmThreadId, m.summary])),
  })) as never,
  useRequestSitrep: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
  useEnvironmentIdentities: (() => []) as never,
  usePrimaryEnvironmentId: (() => "env-1") as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import { Route as AllProjectsRoute } from "../../routes/_chat.all-projects";
import { MainAppLocationTracker } from "../sidebar/mainAppLocation";
import { ThreadSidebarWithRail } from "../sidebar/ThreadSidebarWithRail";
import { GOAL_MAP_LAYOUT } from "@t3tools/shared/goalMap";

import { SidebarProvider, useSidebar } from "../ui/sidebar";
import { GOAL_MAP_NOW, GOAL_MAP_PROJECTS, goalMapFixture } from "./goalMap.test-fixtures";

function threadShell(id: string, projectId: string): EnvironmentThreadShell {
  return {
    environmentId: "env-1" as never,
    id: id as never,
    projectId: projectId as never,
    title: id,
    providerInstanceId: "codex" as never,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null } as never,
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: GOAL_MAP_NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: GOAL_MAP_NOW,
    updatedAt: GOAL_MAP_NOW,
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
    lastVisitedAt: GOAL_MAP_NOW,
    deletedAt: null,
    source: {} as never,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.projects = GOAL_MAP_PROJECTS.map(([id, , title]) => ({
    id,
    environmentId: "env-1",
    title,
    workspaceRoot: `/repo/${id}`,
    createdAt: GOAL_MAP_NOW,
    updatedAt: GOAL_MAP_NOW,
  }));
  state.managers = goalMapFixture();
  state.threads = state.managers.map((entry) =>
    threadShell(entry.summary.pmThreadId, entry.summary.projectId),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

/** Opens the phone sidebar sheet, as the app's header button does. */
let openSheet = () => {};

/** The app shell: a sidebar column on desktop; on phones a sheet that opens over the page. */
function Shell() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  openSheet = () => setOpenMobile(true);
  const sidebar = (
    <div
      data-testid="sidebar-area"
      style={
        isMobile
          ? {
              position: "fixed",
              inset: "0 0 auto 0",
              height: 360,
              zIndex: 20,
              display: "flex",
              flexDirection: "column",
            }
          : { width: 320, height: "100vh", flexShrink: 0, display: "flex", flexDirection: "column" }
      }
      className="bg-sidebar"
    >
      <ThreadSidebarWithRail />
    </div>
  );
  return (
    <div style={{ display: "flex", width: "100%" }}>
      {!isMobile || openMobile ? sidebar : null}
      <div style={{ display: "flex", minWidth: 0, flex: 1 }}>
        <Outlet />
      </div>
    </div>
  );
}

function renderApp(initial = "/env-1/pm-busyboy") {
  const AllProjects = AllProjectsRoute.options.component!;
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Shell />
        <MainAppLocationTracker />
      </SidebarProvider>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/all-projects", component: AllProjects }),
    ...[
      "/",
      "/$environmentId/$threadId",
      "/tasks/$environmentId/$projectId/$taskId",
      "/pull-requests",
    ].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: () => <div data-testid="other-page">page</div>,
      }),
    ),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const rail = () => container.querySelector<HTMLElement>("[data-workspace-rail]");
const railEntry = (label: string) =>
  [...rail()!.querySelectorAll<HTMLElement>("button")].find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent) === label,
  )!;
const svg = () => container.querySelector<SVGSVGElement>("[data-goal-map]")!;
const goalNode = (id: string) => svg().querySelector<SVGGElement>(`[data-goal-node="${id}"]`)!;
const taskNode = (id: string) => svg().querySelector<SVGGElement>(`[data-task-node="${id}"]`)!;
const pill = (goalId: string) =>
  svg().querySelector<SVGGElement>(`[data-next-action="${goalId}"]`)!;
const counts = (goalId: string) =>
  svg().querySelector(`[data-goal-counts="${goalId}"]`)?.textContent;
const noHorizontalOverflow = () =>
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
/**
 * Every goal cell lies inside the svg and the svg inside the window's width. Phones see the
 * whole map at once; desktop keeps text readable and scrolls the map area when it is taller.
 */
function expectMapFits(whole: "screen" | "width") {
  const box = svg().getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth + 0.5);
  if (whole === "screen") expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 0.5);
  for (const cell of svg().querySelectorAll("[data-goal-cell]")) {
    const rect = cell.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
    expect(rect.top).toBeGreaterThanOrEqual(box.top - 0.5);
    expect(rect.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
  }
}
/** Screen pixels per map unit. */
const mapScale = () => svg().getScreenCTM()!.a;
/** The rendered font size of an svg text element, in screen pixels. */
const onScreenFontSize = (selector: string) => {
  const element = svg().querySelector<SVGTextElement>(selector)!;
  return Number(element.getAttribute("font-size")) * element.getScreenCTM()!.a;
};
/** Goal cell `index` of the fixed layout, in screen coordinates. */
function screenCell(index: number) {
  const L = GOAL_MAP_LAYOUT;
  const m = svg().getScreenCTM()!;
  const x = (index % L.columns) * L.cellWidth;
  const y = Math.floor(index / L.columns) * L.cellHeight;
  return {
    left: m.e + x * m.a,
    top: m.f + y * m.d,
    right: m.e + (x + L.cellWidth) * m.a,
    bottom: m.f + (y + L.cellHeight) * m.d,
  };
}
/** The viewBox once layout and any zoom animation have settled. */
async function settledViewBox(): Promise<string> {
  let settled = "";
  await vi.waitFor(async () => {
    const before = svg().getAttribute("viewBox")!;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(svg().getAttribute("viewBox")).toBe(before);
    settled = before;
  });
  return settled;
}
const nodeCoordinates = () =>
  [...svg().querySelectorAll("[data-goal-node] circle, [data-task-node] circle")].map((circle) => [
    circle.closest("[data-goal-node], [data-task-node]")!.getAttribute("data-goal-node") ??
      circle.closest("[data-task-node]")!.getAttribute("data-task-node"),
    circle.getAttribute("cx"),
    circle.getAttribute("cy"),
  ]);

it("opens All projects from the rail on desktop and reads each goal's progress and next step", async () => {
  await page.viewport(1280, 800);
  const app = renderApp();
  await app.render();
  await vi.waitFor(() => expect(rail()?.getAttribute("data-workspace-rail")).toBe("column"));
  expect(railEntry("채팅").getAttribute("aria-current")).toBe("page");

  await userEvent.click(railEntry("전체 프로젝트"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/all-projects"), {
    timeout: 3000,
  });
  await vi.waitFor(() => expect(svg()).not.toBeNull(), { timeout: 3000 });
  expect(railEntry("전체 프로젝트").getAttribute("aria-current")).toBe("page");
  expect(railEntry("채팅").getAttribute("aria-current")).toBeNull();
  expect(container.querySelector("[data-all-projects] h1")?.textContent).toBe("전체 프로젝트");
  expect(container.querySelector("[data-director-briefing]")?.textContent).toContain(
    "온보딩 개선은 승인 1건을 기다리고 있어요",
  );

  // Four goals plus the open work no goal covers.
  expect(
    [...svg().querySelectorAll("[data-goal-node]")].map((node) =>
      node.getAttribute("data-goal-node"),
    ),
  ).toEqual(["goal-onboarding", "goal-build", "goal-mobile", "goal-docs", "goal:none"]);
  expect(counts("goal-onboarding")).toBe("남은 5 · 완료 2");
  expect(counts("goal-build")).toBe("남은 2 · 완료 2");
  expect(counts("goal-mobile")).toBe("남은 2 · 완료 1");
  expect(counts("goal-docs")).toBe("남은 0 · 완료 2");
  expect(counts("goal:none")).toBe("남은 1 · 완료 0");
  expect(goalNode("goal-onboarding").textContent).toContain("2/7");
  expect(pill("goal-onboarding").getAttribute("aria-label")).toBe(
    "내 차례 · 승인 · BB-123 가입 승인 흐름",
  );
  expect(pill("goal-build").getAttribute("aria-label")).toBe("진행 중 · IN-1 CI 캐시 고치기");
  expect(pill("goal-mobile").getAttribute("aria-label")).toBe("대기 · AP-1 스토어 스크린샷 만들기");
  expect(pill("goal-docs").textContent).toBe("남은 일 없음");
  // Long next steps are cut to the text block; the visible start matches.
  expect(pill("goal-onboarding").textContent).toMatch(/^내 차례 · 승인 · BB-123 /);
  expect(pill("goal:none").getAttribute("aria-label")).toBe("대기 · SI-6 랜딩 페이지 문구");
  expect(svg().querySelectorAll("[data-done-dot]")).toHaveLength(7);

  // The user's turn is marked on both the goal's next step and the task itself.
  expect(pill("goal-onboarding").getAttribute("data-user-turn")).toBe("approval");
  expect(taskNode("bb-123").getAttribute("data-user-turn")).toBe("approval");
  expect(taskNode("bb-123").textContent).toContain("내 차례");
  expect(taskNode("bb-119").hasAttribute("data-user-turn")).toBe(false);
  expect(taskNode("bb-122").textContent).toContain("상위: BB-119");

  // The waits-on chain: each task points at the one it waits on.
  expect(
    [...svg().querySelectorAll("[data-waits-edge]")].map((edge) =>
      edge.getAttribute("data-waits-edge"),
    ),
  ).toEqual([
    "waits:task:env-1/bb-120:task:env-1/bb-119",
    "waits:task:env-1/bb-121:task:env-1/bb-120",
    "waits:task:env-1/bb-122:task:env-1/bb-121",
  ]);

  // Desktop has no zoom.
  expect(svg().getAttribute("data-zoomed")).toBe("false");
  const viewBox = await settledViewBox();
  await userEvent.click(goalNode("goal-build"));
  expect(svg().getAttribute("data-zoomed")).toBe("false");
  expect(await settledViewBox()).toBe(viewBox);
  noHorizontalOverflow();
  // Every goal fits on screen without scrolling, at a readable scale.
  expectMapFits("screen");
  expect(mapScale()).toBeGreaterThanOrEqual(0.85);
  // The text block sits right under its goal circle.
  const circle = goalNode("goal-onboarding").getBoundingClientRect();
  const title = svg()
    .querySelector('[data-goal-text="goal-onboarding"] [data-goal-title]')!
    .getBoundingClientRect();
  expect(title.top - circle.bottom).toBeGreaterThanOrEqual(0);
  expect(title.top - circle.bottom).toBeLessThan(20);
  await page.screenshot({ path: "__screenshots__/goal-map-desktop.png" });

  // A task node opens its task.
  await userEvent.click(taskNode("bb-120"));
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/bb-120"),
  );

  // Back on the map, the next step opens the task it names.
  await userEvent.click(railEntry("전체 프로젝트"));
  await vi.waitFor(() => expect(svg()).not.toBeNull(), { timeout: 3000 });
  await userEvent.click(pill("goal-onboarding"));
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/bb-123"),
  );

  // Chat goes back to the last chat, and the Director's avatar opens its chat.
  await userEvent.click(railEntry("전체 프로젝트"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/all-projects"), {
    timeout: 3000,
  });
  await userEvent.click(railEntry("채팅"));
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/bb-123"),
  );
  await userEvent.click(railEntry("전체 프로젝트"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/all-projects"), {
    timeout: 3000,
  });
  await userEvent.click(rail()!.querySelector<HTMLElement>("[data-director-rail]")!);
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/director-thread"));
  expect(container.querySelector("[data-goal-map]")).toBeNull();
});

it("marks neither view on a utility page, and Chat goes back to the last chat from there", async () => {
  await page.viewport(1280, 800);
  const app = renderApp("/env-1/pm-busyboy");
  await app.render();
  await vi.waitFor(() => expect(rail()?.getAttribute("data-workspace-rail")).toBe("column"));
  await act(() => app.router.navigate({ href: "/pull-requests" }));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/pull-requests"));
  await vi.waitFor(() => expect(railEntry("채팅").getAttribute("aria-current")).toBeNull());
  expect(railEntry("전체 프로젝트").getAttribute("aria-current")).toBeNull();

  await userEvent.click(railEntry("채팅"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-busyboy"));
  expect(railEntry("채팅").getAttribute("aria-current")).toBe("page");
});

it("shows the rail as tabs on a phone and zooms into a tapped goal", async () => {
  await page.viewport(390, 844);
  const app = renderApp();
  await app.render();
  await act(() => openSheet());
  await vi.waitFor(() => expect(rail()?.getAttribute("data-workspace-rail")).toBe("tabs"));
  expect(railEntry("채팅").getAttribute("aria-current")).toBe("page");
  await page.screenshot({ path: "__screenshots__/goal-map-phone-rail.png" });

  await userEvent.click(railEntry("전체 프로젝트"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/all-projects"), {
    timeout: 3000,
  });
  // The sheet closes behind the choice.
  await vi.waitFor(() => expect(rail()).toBeNull());
  await vi.waitFor(() => expect(svg()).not.toBeNull(), { timeout: 3000 });
  // Measure only after the sheet has closed and the map has stopped resizing.
  const whole = await settledViewBox();
  await vi.waitFor(() => {
    noHorizontalOverflow();
    expectMapFits("screen");
    expect(svg().getAttribute("data-zoomed")).toBe("false");
    // The overview's goal text is scaled up to stay readable and stays inside its own cell.
    for (const [index, id] of [
      "goal-onboarding",
      "goal-build",
      "goal-mobile",
      "goal-docs",
      "goal:none",
    ].entries()) {
      expect(onScreenFontSize(`[data-goal-counts="${id}"]`)).toBeGreaterThanOrEqual(9.9);
      const text = svg().querySelector(`[data-goal-text="${id}"]`)!.getBoundingClientRect();
      const cell = screenCell(index);
      expect(text.left).toBeGreaterThanOrEqual(cell.left - 0.5);
      expect(text.right).toBeLessThanOrEqual(cell.right + 0.5);
      expect(text.bottom).toBeLessThanOrEqual(cell.bottom + 0.5);
    }
  });
  // Task labels wait for the zoom.
  expect(taskNode("bb-123").querySelector("text")).toBeNull();
  await page.screenshot({ path: "__screenshots__/goal-map-phone.png" });

  await userEvent.click(goalNode("goal-onboarding"));
  await vi.waitFor(() => expect(svg().getAttribute("data-zoomed")).toBe("true"));
  // The zoom eases in and settles on the goal's cell.
  const zoomedIn = await settledViewBox();
  expect(zoomedIn).not.toBe(whole);
  expect(Number(zoomedIn.split(" ")[2])).toBeLessThan(Number(whole.split(" ")[2]));
  noHorizontalOverflow();
  await page.screenshot({ path: "__screenshots__/goal-map-phone-zoomed.png" });

  // Zoomed in, a task is easy to tap and opens its task.
  await userEvent.click(page.getByRole("button", { name: "전체 보기", exact: true }));
  await vi.waitFor(() => expect(svg().getAttribute("data-zoomed")).toBe("false"));
  expect(await settledViewBox()).toBe(whole);
  expect(page.getByRole("button", { name: "전체 보기" }).elements()).toHaveLength(0);

  await userEvent.click(goalNode("goal-onboarding"));
  await vi.waitFor(() => expect(svg().getAttribute("data-zoomed")).toBe("true"));
  await userEvent.click(taskNode("bb-123"));
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/bb-123"),
  );
});

it("draws the same map in the same place after a remount", async () => {
  await page.viewport(1280, 800);
  let app = renderApp("/all-projects");
  await app.render();
  await vi.waitFor(() => expect(svg()).not.toBeNull(), { timeout: 3000 });
  const first = nodeCoordinates();
  expect(first.length).toBeGreaterThan(10);
  await act(() => root.unmount());
  root = createRoot(container);
  // Entries arriving in another order change nothing.
  state.managers = goalMapFixture().toReversed();
  app = renderApp("/all-projects");
  await app.render();
  await vi.waitFor(() => expect(svg()).not.toBeNull(), { timeout: 3000 });
  expect(nodeCoordinates()).toEqual(first);
});
