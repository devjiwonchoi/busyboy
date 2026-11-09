import "~/index.css";
import type { ProjectTeamAttentionSummary, ScopedThreadRef } from "@t3tools/contracts";
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
  useThreadShell: (() => null) as never,
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
  useParams,
} from "@tanstack/react-router";

import { goalGraphFixture } from "../goalGraph/goalGraph.test-fixtures";

import { DirectorWorkspaceSurface } from "./DirectorWorkspaceSurface";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";
import { DirectorWorkspaceToggle } from "./DirectorWorkspaceToggle";
import { Route as AllProjectsRoute } from "../../routes/_chat.all-projects";

const noop = () => {};
function ThreadView(props: { threadRef: ScopedThreadRef }) {
  const ref = props.threadRef;
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
        <header>
          {ref.threadId === "director-thread" ? <DirectorWorkspaceToggle threadRef={ref} /> : null}
        </header>
        대화 {ref.threadId}
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
function ChatRoute() {
  const { threadId } = useParams({ strict: false });
  return <ThreadView threadRef={{ environmentId: "env-1", threadId } as ScopedThreadRef} />;
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  state.managers = goalGraphFixture().map((entry) =>
    entry.summary.kind === "director"
      ? { ...entry, summary: { ...entry.summary, pmThreadId: "director-thread" as never } }
      : entry,
  );
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(initial: string) {
  const redirect = AllProjectsRoute.options.component;
  if (redirect === undefined) {
    throw new Error("Missing all-projects redirect");
  }
  const base = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: base.addChildren([
      createRoute({
        getParentRoute: () => base,
        path: "/",
        component: () => <div>홈</div>,
      }),
      createRoute({
        getParentRoute: () => base,
        path: "/all-projects",
        component: redirect,
      }),
      createRoute({
        getParentRoute: () => base,
        path: "/$environmentId/$threadId",
        component: ChatRoute,
      }),
    ]),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

it("shows a way home until a Director exists, then redirects to it", async () => {
  const managers = state.managers;
  state.managers = managers.filter((entry) => entry.summary.kind !== "director");
  const router = await open("/all-projects");
  expect(router.state.location.pathname).toBe("/all-projects");
  await vi.waitFor(() => expect(container.textContent).toContain("디렉터를 찾는 중이에요"));
  await act(() => {
    state.managers = managers;
    for (const listener of state.listeners) {
      listener();
    }
  });
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/director-thread"));
  expect(router.history.length).toBe(1);
});

it("leaves /all-projects for home from the notice when there is no Director", async () => {
  state.managers = [];
  const router = await open("/all-projects");
  await userEvent.click(page.getByRole("link", { name: "홈으로", exact: true }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(container.textContent).toContain("홈");
});

it("opens the desktop workspace only from the header as one goal view, and stays closed on re-entry", async () => {
  await page.viewport(1440, 900);
  const router = await open("/env-1/director-thread");
  await vi.waitFor(() => expect(container.querySelector('[data-testid="chat"]')).toBeTruthy());
  expect(container.querySelector('[data-testid="director-workspace-surface"]')).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "전체 프로젝트", exact: true }));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="director-workspace-surface"]')).toBeTruthy(),
  );
  expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("대화");
  // One view: no graph / map tabs.
  expect(page.getByRole("button", { name: "목표 그래프", exact: true }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "지도", exact: true }).elements()).toHaveLength(0);
  expect(container.querySelector("[data-project-map]")).toBeNull();
  await page.screenshot({ path: "../../../.screenshots/bu99-director-desktop.png" });
  const ref = { environmentId: "env-1", threadId: "director-thread" } as ScopedThreadRef;
  await act(() => useRightPanelStore.getState().close(ref));
  expect(container.querySelector('[data-testid="director-workspace-surface"]')).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "전체 프로젝트", exact: true }));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="director-workspace-surface"]')).toBeTruthy(),
  );
  await act(() => useRightPanelStore.getState().close(ref));
  await act(async () => {
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "other" },
    });
  });
  await act(async () => {
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "director-thread" },
    });
  });
  await vi.waitFor(() => expect(container.textContent).toContain("대화 director-thread"));
  expect(container.querySelector('[data-testid="director-workspace-surface"]')).toBeNull();
  await page.screenshot({ path: "__screenshots__/director-reentry-stays-closed.png" });
});

it("redirects the old URL on mobile and opens the workspace sheet only from the header", async () => {
  await page.viewport(390, 844);
  const router = await open("/all-projects");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/director-thread"));
  expect(document.querySelector('[data-testid="director-workspace-surface"]')).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "전체 프로젝트", exact: true }));
  await vi.waitFor(() =>
    expect(
      document.querySelector('[role="dialog"] [data-testid="director-workspace-surface"]'),
    ).toBeTruthy(),
  );
  await page.screenshot({ path: "../../../.screenshots/bu99-director-mobile-sheet.png" });
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: "전체 프로젝트", exact: true }).element()).toBeTruthy(),
  );
});
