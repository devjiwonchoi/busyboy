import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const NOW = "2026-11-05T09:00:00.000Z";

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const jump = (key: string) => ({
    command: `thread.jump.${key}`,
    shortcut: { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true },
  });
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make([jump("1"), jump("2"), jump("3"), jump("4")]) as never,
  };
});
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

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import Sidebar from "../Sidebar";
import { useUiStateStore } from "../../uiStateStore";
import { page } from "vite-plus/test/browser";
import { SidebarProvider } from "../ui/sidebar";

function threadShell(id: string, projectId: string, updatedAt: string): EnvironmentThreadShell {
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
    latestUserMessageAt: updatedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
    lastVisitedAt: updatedAt,
    deletedAt: null,
    source: {} as never,
  };
}

function project(id: string, title: string) {
  return {
    id,
    environmentId: "env-1",
    title,
    workspaceRoot: `/repo/${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useUiStateStore.setState({ projectOrder: [], sidebarProjectScopeKey: null });
  state.projects = [project("busyboy", "프로젝트"), project("director", "시스템 프로젝트")];
  state.threads = [
    threadShell("pm-thread", "busyboy", NOW),
    threadShell("director-thread", "director", NOW),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
      }),
    },
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "director" as never,
        pmThreadId: "director-thread" as never,
        kind: "director",
        persona: { name: "총괄", avatar: { kind: "emoji", emoji: "🧭" }, voice: "chill" },
      }),
    },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pressJump(key: string) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function renderSidebarApp() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Sidebar />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => null,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const headings = () => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-project-manager-heading"]'),
];
const header = (label: string) => {
  const heading = headings().find((node) => node.textContent?.includes(label));
  const element = heading?.closest<HTMLElement>('[data-testid="sidebar-project-header"]');
  if (!element) {
    throw new Error(`Missing project ${label}`);
  }
  return element;
};
/** Drags a project header with the mouse until its center sits on the target's center. */
async function dragProject(label: string, onto: string) {
  const source = header(label);
  const from = source.getBoundingClientRect();
  const to = header(onto).getBoundingClientRect();
  const x = from.left + 20;
  const startY = from.top + from.height / 2;
  const endY = startY + (to.top + to.height / 2 - startY);
  const pointer = (type: string, y: number, buttons: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
    });
  await act(async () => {
    (source.querySelector("button") ?? source).dispatchEvent(pointer("pointerdown", startY, 1));
  });
  for (let step = 1; step <= 10; step++) {
    await act(async () => {
      document.dispatchEvent(pointer("pointermove", startY + ((endY - startY) * step) / 10, 1));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }
  await act(async () => {
    document.dispatchEvent(pointer("pointerup", endY, 0));
  });
}

it("puts the Director first, keeps a dragged order, and follows that order for Cmd+number", async () => {
  await page.viewport(1280, 800);
  const app = renderSidebarApp();
  await app.render();
  await vi.waitFor(() => expect(headings()).toHaveLength(2));
  expect(headings()[0]!.textContent).toContain("총괄");
  expect(headings()[0]!.textContent?.includes("시스템 프로젝트")).toBe(false);
  expect(headings()[0]!.querySelector("[data-testid=sidebar-project-manager-toggle]")).toBeTruthy();
  await pressJump("1");
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/director-thread"));
  await dragProject("총괄", "프로젝트");
  await vi.waitFor(() => expect(headings()[1]!.textContent).toContain("총괄"));
  expect(useUiStateStore.getState().projectOrder.length).toBeGreaterThan(0);
  await pressJump("1");
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-thread"));
  await pressJump("2");
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/director-thread"));
});
