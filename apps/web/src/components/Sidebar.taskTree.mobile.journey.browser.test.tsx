import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTaskReference, ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { page } from "vite-plus/test/browser";
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

function subagentOfPm(id: string, title: string): EnvironmentThreadShell {
  return {
    ...threadShell(id, "busyboy", "2026-11-05T08:30:00.000Z"),
    title,
    lineage: {
      rootThreadId: "pm-thread",
      parentThreadId: "pm-thread",
      relationshipToParent: "subagent",
    } as never,
  };
}

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

beforeEach(async () => {
  await page.viewport(390, 844);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const key of ["collapsed-projects", "collapsed-tasks", "expanded-thread-groups"]) {
    localStorage.removeItem(`busyboy:sidebar:${key}`);
  }
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", NOW),
    subagentOfPm("parent-lead", "Parent task"),
    subagentOfPm("child-lead", "Child lead"),
    ...["launch-1", "launch-2", "launch-3"].map((id, index) => ({
      ...threadShell(id, "busyboy", NOW),
      // Exercise both a direct launcher and a descendant launcher chain.
      launchedByThreadId: (index === 0
        ? "child-lead"
        : index === 1
          ? "launch-1"
          : "intermediate") as never,
    })),
    {
      ...threadShell("intermediate", "busyboy", NOW),
      lineage: {
        rootThreadId: "pm-thread",
        parentThreadId: "child-lead",
        relationshipToParent: "subagent",
      } as never,
    },
    threadShell("user-thread", "busyboy", "2026-11-05T08:00:00.000Z"),
    { ...threadShell("pm-launched", "busyboy", NOW), launchedByThreadId: "pm-thread" as never },
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        taskKeyPrefix: "BB",
        tasks: [
          task("parent", 1, "Parent task", { leadThreadId: "parent-lead" as never }),
          task("waiting", 2, "Waiting sibling", {
            parentTaskId: "parent" as never,
            waitsOn: ["prerequisite" as never],
          }),
          task("child", 3, "Child lead", {
            parentTaskId: "parent" as never,
            leadThreadId: "child-lead" as never,
          }),
          task("prerequisite", 4, "Prerequisite sibling", { parentTaskId: "parent" as never }),
        ],
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
    history: createMemoryHistory({ initialEntries: ["/env-1/pm-thread"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

function threadItem(id: string) {
  return container.querySelector<HTMLElement>(`[data-thread-item="env-1:${id}"]`);
}

/** Dispatch the pointer sequence a phone sends, without engaging row swipe navigation. */
async function tap(button: HTMLButtonElement) {
  const box = button.getBoundingClientRect();
  expect(box.width).toBeGreaterThanOrEqual(28);
  expect(box.height).toBeGreaterThanOrEqual(28);
  await act(async () => {
    const pointer = {
      bubbles: true,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    };
    button.dispatchEvent(new PointerEvent("pointerdown", pointer));
    button.dispatchEvent(new PointerEvent("pointerup", pointer));
    button.click();
  });
}

describe("phone: sidebar task tree", () => {
  afterEach(async () => {
    await page.viewport(1280, 800);
  });

  it("toggles subtasks and launched threads with touch-sized controls", async () => {
    const app = renderSidebarApp();
    await app.render();
    await vi.waitFor(() => expect(threadItem("child-lead")).toBeTruthy());
    const group = container.querySelector<HTMLButtonElement>('[data-thread-group="child"] button')!;
    expect(group.getAttribute("aria-expanded")).toBe("false");
    await tap(group);
    await vi.waitFor(() =>
      expect(threadItem("launch-3")?.getAttribute("data-tree-depth")).toBe("3"),
    );
    await tap(
      threadItem("parent-lead")!.querySelector<HTMLButtonElement>(
        'button[aria-label="하위 태스크 접기"]',
      )!,
    );
    // Collapsed rows leave through the list's exit animation; wait for them to go.
    await vi.waitFor(() => {
      expect(threadItem("child-lead")).toBeNull();
      expect(threadItem("launch-1")).toBeNull();
    });
    expect(threadItem("parent-lead")!.querySelector('[data-subtask-progress="0/3"]')).toBeTruthy();
    await tap(
      threadItem("parent-lead")!.querySelector<HTMLButtonElement>(
        'button[aria-label="하위 태스크 펼치기"]',
      )!,
    );
    await vi.waitFor(() =>
      expect(threadItem("child-lead")?.getAttribute("data-tree-depth")).toBe("1"),
    );
    expect(threadItem("launch-3")?.getAttribute("data-tree-depth")).toBe("3");
    expect(threadItem("user-thread")?.getAttribute("data-tree-depth")).toBe("0");
    expect(app.router.state.location.pathname).toBe("/env-1/pm-thread");
  });
});
