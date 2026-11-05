import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The sidebar reads projects and threads from this store, so a test can add
// activity or a project and watch the sidebar re-render.
const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    threads: [] as unknown[],
    projects: [] as unknown[],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => listeners.forEach((listener) => listener()),
  };
});

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useThreadShells: (() => useSyncExternalStore(state.subscribe, () => state.threads)) as never,
    useProjects: (() => useSyncExternalStore(state.subscribe, () => state.projects)) as never,
    useServerConfigs: (() => new Map()) as never,
  };
});
vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => []) as never,
  useEnvironmentProjectTeamAttention: (() => ({
    byProjectId: new Map(),
    byPmThreadId: new Map(),
  })) as never,
  useRequestSitrep: (() => vi.fn()) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
  useEnvironmentIdentities: (() => []) as never,
  usePrimaryEnvironmentId: (() => "env-1") as never,
}));
vi.mock(import("../state/session"), async (original) => ({
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

import { PERSISTED_STATE_KEY, parsePersistedState, useUiStateStore } from "../uiStateStore";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

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

function project(id: string, title: string, createdAt: string, isScratch = false) {
  return {
    id,
    environmentId: "env-1",
    title,
    workspaceRoot: `/repo/${id}`,
    repositoryIdentity: null,
    isScratch,
    createdAt,
    updatedAt: createdAt,
  };
}

function setThreads(threads: unknown[]) {
  act(() => {
    state.threads = threads;
    state.emit();
  });
}

function setProjects(projects: unknown[]) {
  act(() => {
    state.projects = projects;
    state.emit();
  });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useUiStateStore.setState({ projectOrder: [], sidebarProjectScopeKey: null });
  // "No project" is the oldest, and Beta has the newest thread, yet the
  // sidebar starts in creation order with "No project" last.
  state.projects = [
    project("scratch", "scratch", "2026-01-01T00:00:00.000Z", true),
    project("alpha", "Alpha", "2026-02-01T00:00:00.000Z"),
    project("beta", "Beta", "2026-03-01T00:00:00.000Z"),
  ];
  state.threads = [
    threadShell("scratch-thread", "scratch", "2026-11-05T09:00:00.000Z"),
    threadShell("alpha-thread", "alpha", "2026-11-05T08:00:00.000Z"),
    threadShell("beta-thread", "beta", "2026-11-05T08:30:00.000Z"),
  ];
  container = document.createElement("div");
  container.style.height = "800px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Sidebar />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return act(async () => root.render(<RouterProvider router={router} />));
}

const projectHeaders = () => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-project-header"]'),
];
const projectOrder = () => projectHeaders().map((header) => header.textContent?.trim());
const header = (label: string) => {
  const found = projectHeaders().find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`No project header "${label}"`);
  return found;
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

describe("sidebar project order", () => {
  it("keeps the order the user drags, through new activity, new projects and a reload", async () => {
    await render();
    await vi.waitFor(() => expect(projectOrder()).toEqual(["Alpha", "Beta", "No project"]));

    // New activity in Alpha no longer moves it.
    setThreads([...state.threads, threadShell("alpha-newer", "alpha", "2026-11-05T09:30:00.000Z")]);
    expect(projectOrder()).toEqual(["Alpha", "Beta", "No project"]);

    await dragProject("Beta", "Alpha");
    await vi.waitFor(() => expect(projectOrder()).toEqual(["Beta", "Alpha", "No project"]));

    // New activity in Alpha keeps the dragged order.
    setThreads([
      ...state.threads,
      threadShell("alpha-newest", "alpha", "2026-11-05T10:00:00.000Z"),
    ]);
    expect(projectOrder()).toEqual(["Beta", "Alpha", "No project"]);

    // A new project goes at the end, above "No project".
    setProjects([...state.projects, project("gamma", "Gamma", "2026-11-05T10:00:00.000Z")]);
    expect(projectOrder()).toEqual(["Beta", "Alpha", "Gamma", "No project"]);

    // Reload: the app saves on unload and reads the saved state on start.
    window.dispatchEvent(new Event("beforeunload"));
    await act(() => root.unmount());
    useUiStateStore.setState({ projectOrder: [] });
    useUiStateStore.setState(
      parsePersistedState(JSON.parse(localStorage.getItem(PERSISTED_STATE_KEY) ?? "{}")),
    );
    root = createRoot(container);
    await render();
    await vi.waitFor(() =>
      expect(projectOrder()).toEqual(["Beta", "Alpha", "Gamma", "No project"]),
    );
  });

  it("keeps No project last: it can't be dragged and nothing drops below it", async () => {
    await render();
    await vi.waitFor(() => expect(projectOrder()).toEqual(["Alpha", "Beta", "No project"]));

    await dragProject("No project", "Alpha");
    expect(projectOrder()).toEqual(["Alpha", "Beta", "No project"]);

    // Dropping Alpha on "No project" leaves it last among the projects instead.
    await dragProject("Alpha", "No project");
    await vi.waitFor(() => expect(projectOrder()).toEqual(["Beta", "Alpha", "No project"]));
  });
});
