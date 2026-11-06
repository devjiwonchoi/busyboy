import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const NOW = "2026-11-05T09:00:00.000Z";

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

vi.mock(import("../state/server"), async (original) => {
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
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => state.threads) as never,
  useProjects: (() => state.projects) as never,
  useServerConfigs: (() => new Map()) as never,
  useEnvironmentIdentities: (() => []) as never,
}));
vi.mock(import("../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: (() => state.groups) as never,
}));
vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => state.managers) as never,
  useEnvironmentProjectTeamAttention: (() => ({
    byProjectId: new Map(state.managers.map((m) => [m.summary.projectId, m.summary])),
    byPmThreadId: new Map(state.managers.map((m) => [m.summary.pmThreadId, m.summary])),
  })) as never,
  useRequestSitrep: (() => vi.fn()) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
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

import { makeProjectManagerSummaryFixture } from "../test-fixtures";
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

function projectGroup(id: string, title: string) {
  const member = project(id, title);
  return {
    ...member,
    projectKey: `env-1:${id}`,
    displayName: title,
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    memberProjects: [member],
    memberProjectRefs: [{ environmentId: "env-1", projectId: id }],
    remoteEnvironmentLabels: [],
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // "busyboy" has a PM; "scratch" does not. busyboy's threads are newer, so it
  // renders first.
  state.projects = [project("busyboy", "busyboy"), project("scratch", "scratch")];
  state.groups = [projectGroup("busyboy", "busyboy"), projectGroup("scratch", "scratch")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    threadShell("busy-first", "busyboy", "2026-11-05T08:58:00.000Z"),
    threadShell("busy-second", "busyboy", "2026-11-05T08:57:00.000Z"),
    threadShell("scratch-first", "scratch", "2026-11-05T08:00:00.000Z"),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
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

describe("sidebar Cmd+number", () => {
  it("counts the project's PM conversation first, then the threads below it", async () => {
    const app = renderSidebarApp();
    await app.render();
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="sidebar-project-manager-heading"]')?.textContent,
      ).toContain("busyboy"),
    );
    const openThread = () => app.router.state.location.pathname;

    await pressJump("1");
    await vi.waitFor(() => expect(openThread()).toBe("/env-1/pm-thread"));
    // The PM heading is highlighted as the open conversation.
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[data-testid="sidebar-project-manager-heading"] [aria-current="page"]',
        ),
      ).not.toBeNull(),
    );

    await pressJump("2");
    await vi.waitFor(() => expect(openThread()).toBe("/env-1/busy-first"));

    await pressJump("3");
    await vi.waitFor(() => expect(openThread()).toBe("/env-1/busy-second"));

    // A project without a PM numbers its threads in the order they show.
    await pressJump("4");
    await vi.waitFor(() => expect(openThread()).toBe("/env-1/scratch-first"));
  });
});
