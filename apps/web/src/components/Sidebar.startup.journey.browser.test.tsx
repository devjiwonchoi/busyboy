import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTaskReference, ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { page } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const NOW = "2026-11-05T09:00:00.000Z";

// The app starts with its thread list in hand, but which threads are PM chats only
// arrives with the PM data a moment later. Until then the sidebar must not list the PM
// chats and their task threads as ordinary rows.

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  attention: null as Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>> | null,
}));

// The PM data stream, driven by the test instead of a server.
vi.mock(import("@t3tools/client-runtime/state/project-team"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  state.attention = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial(true));
  return {
    ...actual,
    createProjectTeamEnvironmentAtoms: ((runtime: never) => ({
      ...actual.createProjectTeamEnvironmentAtoms(runtime),
      attention: () => state.attention,
    })) as never,
  };
});
// The thread list is already in when the app starts.
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellsAtom: Atom.make(() => state.threads) as never,
    },
  };
});

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
  useRequestSitrep: (() => vi.fn()) as never,
  // The real hook reads the summary from atoms; read it from the test's managers instead.
  useLeadThreadTask: ((ref: { threadId: string }, projectId: string | null) =>
    taskForLeadThread(
      state.managers.find((m) => m.summary.projectId === projectId)?.summary ?? null,
      ref.threadId as never,
    )) as never,
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

import { PROJECT_TEAM_ATTENTION_GRACE_MS } from "../state/projectTeam";
import { taskForLeadThread } from "../state/projectTeam.logic";
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
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;

function task(
  id: string,
  number: number,
  title: string,
  overrides: Partial<ProjectTaskReference> = {},
): ProjectTaskReference {
  return {
    id: id as never,
    number,
    parentTaskId: null,
    waitsOn: [],
    title,
    stage: "inbox",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: null,
    ...overrides,
  };
}

function manager(projectId: string, pmThreadId: string, prefix: string, leads: string[]) {
  return {
    environmentId: "env-1",
    summary: makeProjectManagerSummaryFixture({
      projectId: projectId as never,
      pmThreadId: pmThreadId as never,
      taskKeyPrefix: prefix,
      tasks: leads.map((lead, index) =>
        task(`${lead}-task`, index + 1, `${lead} task`, { leadThreadId: lead as never }),
      ),
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const key of ["collapsed-projects", "collapsed-tasks", "expanded-thread-groups"]) {
    localStorage.removeItem(`busyboy:sidebar:${key}`);
  }
  state.projects = [project("alpha", "alpha"), project("beta", "beta")];
  state.groups = [projectGroup("alpha", "alpha"), projectGroup("beta", "beta")];
  state.threads = [
    threadShell("pm-alpha", "alpha", NOW),
    threadShell("pm-beta", "beta", NOW),
    threadShell("alpha-lead-1", "alpha", NOW),
    threadShell("alpha-lead-2", "alpha", NOW),
    threadShell("beta-lead-1", "beta", NOW),
  ];
  state.managers = [
    manager("alpha", "pm-alpha", "AL", ["alpha-lead-1", "alpha-lead-2"]),
    manager("beta", "pm-beta", "BE", ["beta-lead-1"]),
  ];
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  registry.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

function renderSidebarApp() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <div style={{ width: 320, flexShrink: 0 }}>
          <Sidebar />
        </div>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const routes = ["/", "/$environmentId/$threadId", "/tasks/$environmentId/$projectId/$taskId"].map(
    (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/env-1/pm-alpha"] }),
  });
  return {
    router,
    render: () =>
      act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <RouterProvider router={router} />
          </RegistryContext.Provider>,
        ),
      ),
  };
}

const THREADS = ["pm-alpha", "pm-beta", "alpha-lead-1", "alpha-lead-2", "beta-lead-1"];

/** Thread rows in the list right now, in order. */
function listedRows() {
  return THREADS.filter(
    (id) => container.querySelector(`[data-thread-item="env-1:${id}"]`) !== null,
  );
}

function pmHeadings() {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-project-manager-heading"]'),
  ];
}

function pmDataArrives() {
  registry.set(
    state.attention!,
    AsyncResult.success({
      byProjectId: new Map(state.managers.map((m) => [m.summary.projectId, m.summary])),
      byPmThreadId: new Map(state.managers.map((m) => [m.summary.pmThreadId, m.summary])),
    }),
  );
}

/** Records every DOM change that lists a PM chat or task thread as an ordinary row. */
function watchForPlainRows() {
  const frames: string[][] = [];
  const observer = new MutationObserver(() => {
    if (pmHeadings().length > 0) return;
    const rows = listedRows();
    if (rows.length > 0) frames.push(rows);
  });
  observer.observe(container, { childList: true, subtree: true });
  return { frames, stop: () => observer.disconnect() };
}

describe("sidebar on startup", () => {
  for (const [label, width, height] of [
    ["desktop", 1280, 800],
    ["phone", 390, 844],
  ] as const) {
    it(`never lists PM chats as ordinary rows before the PM data arrives (${label})`, async () => {
      await page.viewport(width, height);
      const plainRows = watchForPlainRows();

      const app = renderSidebarApp();
      await app.render();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(listedRows()).toEqual([]);
      expect(pmHeadings()).toEqual([]);

      await act(async () => pmDataArrives());

      await vi.waitFor(() => expect(pmHeadings()).toHaveLength(2));
      await vi.waitFor(() =>
        expect(listedRows()).toEqual(expect.arrayContaining(["alpha-lead-1", "alpha-lead-2"])),
      );
      plainRows.stop();
      expect(plainRows.frames).toEqual([]);
      expect(listedRows()).not.toContain("pm-alpha");
      expect(listedRows()).not.toContain("pm-beta");
    });
  }

  it("shows the list right away when the PM data fails", async () => {
    const app = renderSidebarApp();
    await app.render();
    expect(listedRows()).toEqual([]);

    await act(async () =>
      registry.set(state.attention!, AsyncResult.failure(Cause.fail("offline"))),
    );

    await vi.waitFor(() => expect(listedRows()).not.toEqual([]));
  });

  it("shows the list after a few seconds when the PM data never comes", async () => {
    const app = renderSidebarApp();
    await app.render();
    await new Promise((resolve) => setTimeout(resolve, PROJECT_TEAM_ATTENTION_GRACE_MS - 1000));
    expect(listedRows()).toEqual([]);

    await vi.waitFor(() => expect(listedRows()).not.toEqual([]), { timeout: 3000 });
  });
});
