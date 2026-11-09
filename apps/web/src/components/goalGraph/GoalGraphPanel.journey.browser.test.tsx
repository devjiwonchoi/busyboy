import "~/index.css";

import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  listeners: new Set<() => void>(),
  answers: [] as unknown[],
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
  useAnswerDecision: (() => async (_env: unknown, input: unknown) => {
    state.answers.push(input);
    return AsyncResult.success({});
  }) as never,
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
  state.answers = [];
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
for (const width of [1280, 390]) {
  it(`reuses the panel shell and goal tree at ${width}px`, async () => {
    await page.viewport(width, 844);
    await mount();
    expect(document.querySelector("[data-goal-tree]") === null).toBe(false);
    expect(document.body.textContent).toContain("목표 2는 결정 1건에 막혀 있어요");
    expect(document.body.textContent).toContain("위험 정보 미제공");
    await page.screenshot({ path: `__screenshots__/director-goal-panel-${width}.png` });
    await act(() => useRightPanelStore.getState().close(DIRECTOR));
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, DIRECTOR).isOpen,
    ).toBe(false);
    await userEvent.click(headerToggle());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="director-workspace-surface"]') === null).toBe(
        false,
      ),
    );
    await act(() => useRightPanelStore.getState().openBrowser(DIRECTOR, null));
    expect(document.querySelector('[data-testid="browser-body"]') === null).toBe(false);
    await act(() => useRightPanelStore.getState().open(DIRECTOR, "director-workspace"));
    await userEvent.click(page.getByRole("button", { name: "최근 24시간", exact: true }));
    expect(document.querySelectorAll("[data-workspace-attention]").length).toBe(3);
  });
}
it("answers through the existing card and updates the panel from the subscription", async () => {
  await mount();
  await userEvent.click(page.getByRole("button", { name: "a 제안 카드 열기", exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"] [data-decision-card="card-a-1"]') === null).toBe(
      false,
    ),
  );
  const card = document.querySelector<HTMLElement>(
    '[role="dialog"] [data-decision-card="card-a-1"]',
  )!;
  const textarea = card.querySelector<HTMLTextAreaElement>("textarea")!;
  await userEvent.fill(textarea, "이 방향으로 진행해 주세요");
  await userEvent.click(card.querySelector<HTMLElement>("[data-decision-card-submit]")!);
  await vi.waitFor(() => expect(state.answers.length).toBe(1));
  await act(() => {
    state.managers = state.managers.map((entry) => ({
      ...entry,
      summary: {
        ...entry.summary,
        decisionCards: entry.summary.decisionCards.filter((card) => card.item.id !== "card-a-1"),
      },
    }));
    for (const listener of state.listeners) listener();
  });
  expect(document.querySelector('[data-workspace-attention="card-a-1"]')).toBe(null);
});
it("keeps attention without goals and refreshes briefing", async () => {
  state.managers = state.managers.map((entry) => ({
    ...entry,
    summary: { ...entry.summary, goals: [] },
  }));
  await mount();
  expect(document.querySelectorAll("[data-workspace-attention]").length).toBe(3);
  await act(() => {
    state.managers = state.managers.map((entry) => ({
      ...entry,
      summary: { ...entry.summary, briefing: "새 브리핑" },
    }));
    for (const listener of state.listeners) listener();
  });
  expect(document.querySelector("[data-director-briefing]")?.textContent).toContain("새 브리핑");
});
it("reuses structured approval impacts and named task links from the inbox", async () => {
  const entry = state.managers[0]!;
  entry.summary = {
    ...entry.summary,
    decisionCards: entry.summary.decisionCards.map((card) => ({
      ...card,
      item: {
        ...card.item,
        context: {
          action: "비용이 드는 작업을 시작합니다",
          reason: "실행 환경이 필요합니다",
          impacts: ["cost", "merge"],
          cost: "$5",
          reversibility: "irreversible",
          recommendation: "영향을 확인하고 진행합니다",
        },
      },
    })),
  };
  const router = await mount();
  const row = document.querySelector<HTMLElement>('[data-workspace-attention="card-a-1"]')!;
  expect(row.textContent).toContain("비용: $5");
  expect(row.textContent).toContain("되돌릴 수 없음");
  expect(row.querySelector('[data-attention-context="known"]')).toBeTruthy();
  expect(row.textContent?.includes("위험 정보 미제공")).toBe(false);
  await userEvent.click(row.querySelector<HTMLElement>("[data-director-inbox-task-link]")!);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/tasks/env-1/a/a-1"));
});
/** A new task, a plan update and a new proposal card arrive through the subscription. */
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
            decisionCards: [...entry.summary.decisionCards, graphCard("a-new", true)],
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

it("shows stalled work, epic status counts and deadlines, then opens a waiting thread", async () => {
  const a = state.managers[0]!;
  a.summary = {
    ...a.summary,
    tasks: a.summary.tasks.map((task) => ({
      ...task,
      parentTaskId: "epic" as never,
      lastOutcome: task.id === "a-2" ? "stalled" : null,
    })),
    waitingThreads: [{ threadId: "question" as never, title: "권한 확인", kind: "question" }],
  };
  const director = state.managers[2]!;
  director.summary = {
    ...director.summary,
    tasks: [graphTask("epic", 10, { stage: "running", waitsOn: ["a-2" as never] })],
  };
  const router = await mount();
  expect(document.body.textContent).toContain("멈춤");
  expect(document.body.textContent).toContain("완료 2 / 5");
  expect(document.body.textContent).toContain("취소 1개 (완료율 제외)");
  expect(document.body.textContent).toContain("작업 a-2 · a 끝나야 시작");
  await userEvent.click(page.getByText("마감", { exact: true }));
  expect(document.body.textContent).toContain("현재 태스크에 마감 필드가 없어요");
  page.getByText("에픽 진행률", { exact: true }).element().scrollIntoView();
  await page.screenshot({ path: "__screenshots__/director-goal-panel-epic.png" });
  document.querySelector('[aria-label="목표 브리핑"]')?.scrollIntoView();
  await page.screenshot({ path: "__screenshots__/director-goal-panel-progress.png" });
  await userEvent.click(page.getByRole("button", { name: "권한 확인 · 채팅 열기", exact: true }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/question"));
});
it("shows empty attention, running and epic states", async () => {
  state.managers = state.managers.map((entry) => ({
    ...entry,
    summary: { ...entry.summary, tasks: [], decisionCards: [], waitingThreads: [], goals: [] },
  }));
  await mount();
  expect(document.body.textContent).toContain("기다리는 일이 없어요");
  expect(document.body.textContent).toContain("진행 중인 태스크가 없어요");
  expect(document.body.textContent).toContain("진행 중인 에픽이 없어요");
  expect(document.body.textContent).toContain("아직 목표가 없어요");
});
