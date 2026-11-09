import "~/index.css";

import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act, useSyncExternalStore } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  listeners: new Set<() => void>(),
}));

// The desktop app: page headers are the window's drag area.
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-09T12:00" }));
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => []) as never,
  useProjects: (() =>
    ["a", "b"].map((id) => ({
      id,
      environmentId: "env-1",
      title: id,
      workspaceRoot: `/repo/${id}`,
      createdAt: "2026-11-05T09:00:00.000Z",
      updatedAt: "2026-11-05T09:00:00.000Z",
    }))) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state.managers,
    )) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
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

import { graphCard, graphTask, goalGraphSignalsFixture } from "./goalGraph.test-fixtures";

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: [] }) as never,
}));
import type { ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";
import { DirectorWorkspaceSurface } from "../director/DirectorWorkspaceSurface";
import { DirectorWorkspaceToggle } from "../director/DirectorWorkspaceToggle";
let root: Root;
let container: HTMLDivElement;
const DIRECTOR = { environmentId: "env-1", threadId: "pm-director" } as ScopedThreadRef;
const OTHER = { environmentId: "env-1", threadId: "pm-a" } as ScopedThreadRef;
const noop = () => undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.managers = goalGraphSignalsFixture();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});
function ThreadView(props: { threadRef: ScopedThreadRef }) {
  const ref = props.threadRef;
  const isDirector = ref.threadId === DIRECTOR.threadId;
  const panel = useRightPanelStore((store) => selectThreadRightPanelState(store.byThreadKey, ref));
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const active = panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const store = useRightPanelStore.getState;
  const tabs = (
    <RightPanelTabs
      mode={sheet ? "sheet" : "inline"}
      open={panel.isOpen}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={panel.surfaces}
      environmentId={null}
      activeSurfaceId={active?.id ?? null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={(surface) => store().activateSurface(ref, surface.id)}
      onCloseSurface={(surface) => store().closeSurface(ref, surface.id)}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={() => store().openBrowser(ref, null)}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddSideChat={noop}
      onAddProject={() => store().open(ref, "director-workspace")}
      onAddTaskPlan={noop}
      projectAvailable
      taskPlanAvailable={false}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      sideChatAvailable={false}
    >
      {active?.kind === "director-workspace" ? <DirectorWorkspaceSurface /> : null}
      {active?.kind === "preview" ? <div data-testid="browser-body">browser</div> : null}
    </RightPanelTabs>
  );
  return (
    <div style={{ display: "flex", height: "100vh", width: "100%" }}>
      <div data-testid="chat" style={{ flex: 1, minWidth: 0 }}>
        <header>{isDirector ? <DirectorWorkspaceToggle threadRef={ref} /> : null}</header>
        chat {ref.threadId}
      </div>
      {sheet ? (
        <RightPanelSheet
          animationDurationMs={0}
          open={panel.isOpen}
          onClose={() => store().close(ref)}
        >
          {tabs}
        </RightPanelSheet>
      ) : panel.isOpen ? (
        tabs
      ) : null}
    </div>
  );
}

// The sheet's own "전체 프로젝트" tab can linger while it closes, so target the chat header.
const headerToggle = () =>
  document.querySelector<HTMLElement>('[data-testid="chat"] header [aria-label="전체 프로젝트"]')!;
async function mount() {
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <ThreadView threadRef={DIRECTOR} />,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/$environmentId/$threadId",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/tasks/$environmentId/$projectId/$taskId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  // Entering the Director leaves the panel closed; the user opens the board.
  expect(document.querySelector('[data-testid="director-workspace-surface"]')).toBe(null);
  await userEvent.click(headerToggle());
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="director-workspace-surface"]') === null).toBe(
      false,
    ),
  );
  return router;
}
/** Puts project a's tasks under a Director epic, so the epic progress section has rows. */
function withEpic() {
  const a = state.managers[0]!;
  a.summary = {
    ...a.summary,
    tasks: a.summary.tasks.map((task) => ({ ...task, parentTaskId: "epic" as never })),
  };
  const director = state.managers[2]!;
  director.summary = {
    ...director.summary,
    tasks: [graphTask("epic", 10, { stage: "running", waitsOn: ["a-2" as never] })],
  };
}
const surface = () =>
  document.querySelector<HTMLElement>('[data-testid="director-workspace-surface"]')!;
for (const width of [1280, 390]) {
  it(`shows only goals, progress and relations at ${width}px`, async () => {
    await page.viewport(width, 844);
    withEpic();
    await mount();
    const text = surface().textContent ?? "";
    // No to-do handling: that lives in the Director chat.
    for (const gone of ["내 할 일", "나를 기다림", "마감", "카드 열기", "위험 정보 미제공"]) {
      expect(text.includes(gone), gone).toBe(false);
    }
    expect(surface().querySelector("[data-workspace-attention]")).toBe(null);
    expect(surface().querySelector("[data-waiting-count]")).toBe(null);
    // One view, no tabs.
    expect(page.getByRole("button", { name: "지도", exact: true }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "목표 그래프", exact: true }).elements()).toHaveLength(
      0,
    );
    // Goals with progress, the goal → project → task tree with waits, and epic progress.
    expect(text).toContain("목표 2는 결정 1건에 막혀 있어요");
    const goal = surface().querySelector<HTMLElement>('[data-goal-node="goal-1"]')!;
    expect(goal.textContent).toMatch(/^▾목표 1.*\d+\/\d+$/);
    expect(surface().querySelector('[data-project-node="env-1/a"]') === null).toBe(false);
    expect(surface().querySelector('[data-task-node="a-1"]') === null).toBe(false);
    const waiting = surface().querySelector<HTMLElement>('[data-task-node="b-1"]')!.parentElement!;
    expect(waiting.textContent).toContain("⏳ A-2 막힘");
    expect(text).toContain("에픽 진행도");
    expect(text).toContain("완료 2 / 5");
    expect(text).toContain("작업 a-2 · a 끝나야 시작");
    await page.screenshot({ path: `__screenshots__/all-projects-${width}.png` });
    // Reopening keeps the same single view.
    await act(() => useRightPanelStore.getState().close(DIRECTOR));
    await userEvent.click(headerToggle());
    await vi.waitFor(() => expect(document.querySelector("[data-goal-tree]") === null).toBe(false));
  });
  it(`opens a task from its node at ${width}px`, async () => {
    await page.viewport(width, 844);
    const router = await mount();
    await userEvent.click(surface().querySelector<HTMLElement>('[data-task-node="a-1"]')!);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/tasks/env-1/a/a-1"));
  });
  it(`opens the PM chat from a project node at ${width}px`, async () => {
    await page.viewport(width, 844);
    const router = await mount();
    await userEvent.click(surface().querySelector<HTMLElement>('[data-project-node="env-1/a"]')!);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/pm-a"));
  });
}
it("refreshes the briefing without goals", async () => {
  state.managers = state.managers.map((entry) => ({
    ...entry,
    summary: { ...entry.summary, goals: [] },
  }));
  await mount();
  await act(() => {
    state.managers = state.managers.map((entry) => ({
      ...entry,
      summary: { ...entry.summary, briefing: "새 브리핑" },
    }));
    for (const listener of state.listeners) listener();
  });
  expect(document.querySelector("[data-director-briefing]")?.textContent).toContain("새 브리핑");
});
/** A new task, a plan update and a new decision card arrive through the subscription. */
function arriveNewWork() {
  state.managers = state.managers.map((entry) =>
    entry.summary.projectId === "a"
      ? {
          ...entry,
          summary: {
            ...entry.summary,
            tasks: [
              ...entry.summary.tasks.map((task) =>
                task.id === "a-2" ? { ...task, stage: "awaiting_approval" as const } : task,
              ),
              graphTask("a-new", 9, { stage: "planning" }),
            ],
            decisionCards: [...entry.summary.decisionCards, graphCard("a-new")],
          },
        }
      : entry,
  );
  for (const listener of state.listeners) listener();
}
for (const width of [1280, 390]) {
  it(`stays closed at ${width}px while new work arrives and on re-entry`, async () => {
    await page.viewport(width, 844);
    const rootRoute = createRootRoute({ component: Outlet });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/",
          component: () => <ThreadView threadRef={DIRECTOR} />,
        }),
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/$environmentId/$threadId",
          component: () => <ThreadView threadRef={OTHER} />,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => root.render(<RouterProvider router={router} />));
    await vi.waitFor(() => expect(document.body.textContent).toContain("chat pm-director"));
    expect(document.querySelector('[data-testid="director-workspace-surface"]')).toBe(null);
    await userEvent.click(headerToggle());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="director-workspace-surface"]') === null).toBe(
        false,
      ),
    );
    await act(() => useRightPanelStore.getState().close(DIRECTOR));
    await act(() => arriveNewWork());
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: "env-1", threadId: "pm-a" },
      }),
    );
    await act(() => router.navigate({ to: "/" }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("chat pm-director"));
    await act(() => arriveNewWork());
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, DIRECTOR).isOpen,
    ).toBe(false);
    expect(headerToggle()).toBeTruthy();
    await page.screenshot({ path: `__screenshots__/director-stays-closed-${width}.png` });
  });
}

it("shows empty goal and epic states", async () => {
  state.managers = state.managers.map((entry) => ({
    ...entry,
    summary: { ...entry.summary, tasks: [], decisionCards: [], waitingThreads: [], goals: [] },
  }));
  await mount();
  expect(document.body.textContent).toContain("진행 중인 에픽이 없어요");
  expect(document.body.textContent).toContain("아직 목표가 없어요");
});
