import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTaskReference, ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { page, userEvent } from "vite-plus/test/browser";
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const LEADS = ["alpha-lead-1", "alpha-lead-2", "beta-lead-1"];

/** Lead rows currently in the list; rows leaving through the exit animation are aria-hidden. */
function visibleLeads() {
  return LEADS.filter((id) => {
    const row = container.querySelector<HTMLElement>(`[data-thread-item="env-1:${id}"]`);
    return row !== null && row.closest('[aria-hidden="true"]') === null;
  });
}

/** Waits for leaving rows to finish their exit animation. */
async function settled(expected: string[]) {
  await vi.waitFor(() =>
    expect(
      LEADS.filter((id) => container.querySelector(`[data-thread-item="env-1:${id}"]`) !== null),
    ).toEqual(expected),
  );
  // Let the remaining rows finish sliding into place before a screenshot.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function pmButton(projectName: string) {
  const heading = [
    ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-project-manager-heading"]'),
  ].find((candidate) => candidate.textContent?.includes(projectName));
  return heading!.querySelector<HTMLElement>("button[aria-expanded]")!;
}

describe("sidebar PM sessions", () => {
  for (const [label, width, height] of [
    ["desktop", 1280, 800],
    ["phone", 390, 844],
  ] as const) {
    it(`hides every PM's sessions until that PM is opened (${label})`, async () => {
      await page.viewport(width, height);
      const app = renderSidebarApp();
      await app.render();

      // At first no PM is open, so no sessions show under any PM.
      await vi.waitFor(() => expect(pmButton("beta")).toBeTruthy());
      expect(visibleLeads()).toEqual([]);
      expect(pmButton("alpha").getAttribute("aria-expanded")).toBe("false");
      expect(pmButton("beta").getAttribute("aria-expanded")).toBe("false");
      await page.screenshot({ path: `__screenshots__/pm-sessions-${label}-1-closed.png` });

      // Opening a PM shows only its sessions.
      await userEvent.click(pmButton("alpha"));
      await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-alpha"));
      await vi.waitFor(() => expect(visibleLeads()).toEqual(["alpha-lead-1", "alpha-lead-2"]));
      expect(pmButton("alpha").getAttribute("aria-expanded")).toBe("true");
      expect(pmButton("beta").getAttribute("aria-expanded")).toBe("false");
      await page.screenshot({ path: `__screenshots__/pm-sessions-${label}-2-alpha.png` });

      // Opening one of its sessions keeps the list open.
      await userEvent.click(
        container.querySelector<HTMLElement>(
          '[data-thread-item="env-1:alpha-lead-2"] [data-testid="sidebar-row-card"]',
        )!,
      );
      await vi.waitFor(() =>
        expect(app.router.state.location.pathname).toBe("/env-1/alpha-lead-2"),
      );
      expect(visibleLeads()).toEqual(["alpha-lead-1", "alpha-lead-2"]);

      // Opening another PM folds the previous list and shows the new one.
      await userEvent.click(pmButton("beta"));
      await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-beta"));
      await vi.waitFor(() => expect(visibleLeads()).toEqual(["beta-lead-1"]));
      expect(pmButton("alpha").getAttribute("aria-expanded")).toBe("false");
      expect(pmButton("beta").getAttribute("aria-expanded")).toBe("true");
      await settled(["beta-lead-1"]);
      await page.screenshot({ path: `__screenshots__/pm-sessions-${label}-3-beta.png` });
    });
  }
});
