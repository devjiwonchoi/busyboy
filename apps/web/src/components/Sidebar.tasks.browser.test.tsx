import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTaskReference, ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const NOW = "2026-11-05T09:00:00.000Z";

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  createTask: (() => undefined) as unknown as (...args: unknown[]) => Promise<unknown>,
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
  useCreateTask: (() => state.createTask) as never,
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
    title,
    stage: "inbox",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem("busyboy:sidebar:collapsed-projects");
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    // The planner of BB-2, and an earlier session of it that the task page lists instead.
    subagentOfPm("lead-2", "BB-2 Fix drag scroll"),
    subagentOfPm("lead-old", "BB-2 Fix drag scroll (first try)"),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        taskKeyPrefix: "BB",
        tasks: [
          task("task-2", 2, "Fix drag scroll", {
            stage: "planning",
            leadThreadId: "lead-2" as never,
          }),
          task("task-3", 3, "Clean up build warnings"),
          task("task-4", 4, "Silence tsc warnings", { parentTaskId: "task-3" as never }),
          task("task-1", 1, "Old work", { stage: "done" }),
        ],
      }),
    },
  ];
  state.createTask = vi.fn(async () =>
    AsyncResult.success({
      task: { ...task("task-5", 5, "Dark mode"), projectId: "busyboy" },
      key: "BB-5",
      versions: [],
      sessions: [],
      children: [],
      openAttention: [],
    }),
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

function taskRowButton(label: string): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>("[data-task-item] button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith(label),
    ) ?? null
  );
}

function threadRow(title: string): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]')].find(
      (card) => card.querySelector("span.sr-only")?.textContent === title,
    ) ?? null
  );
}

describe("sidebar tasks", () => {
  it("lists tasks by key, opens their pages, and adds a task from the PM heading", async () => {
    const app = renderSidebarApp();
    await app.render();

    // Tasks with no session yet show by key, with subtasks under their parent.
    await vi.waitFor(() => expect(taskRowButton("BB-3 Clean up build warnings")).not.toBeNull());
    expect(taskRowButton("BB-3")?.getAttribute("aria-label")).toBe(
      "BB-3 Clean up build warnings, Todo",
    );
    expect(taskRowButton("BB-4")?.closest("li")?.className).toContain("pl-10");
    // Questions are answered in the PM chat, so the sidebar has no "Waiting on you" entry.
    expect(container.textContent).not.toContain("Waiting on you");
    // Done tasks and a task's earlier sessions stay out of the list.
    expect(taskRowButton("BB-1")).toBeNull();
    expect(threadRow("BB-2 Fix drag scroll (first try)")).toBeNull();

    // A task row opens the task page.
    await userEvent.click(taskRowButton("BB-3")!);
    await vi.waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-3"),
    );
    expect(taskRowButton("BB-3")?.getAttribute("aria-current")).toBe("page");

    // The current lead's row stands for its task, so it opens the task page too.
    await userEvent.click(threadRow("BB-2 Fix drag scroll")!);
    await vi.waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-2"),
    );
    expect(threadRow("BB-2 Fix drag scroll")?.getAttribute("aria-current")).toBe("page");

    // Quick dump from the PM heading: title, context, save to the inbox.
    await userEvent.hover(
      container.querySelector('[data-testid="sidebar-project-manager-heading"]')!,
    );
    await userEvent.click(
      container.querySelector<HTMLElement>('button[aria-label="New task in busyboy"]')!,
    );
    const title = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Task title"]');
      expect(input).not.toBeNull();
      return input!;
    });
    await userEvent.type(title, "Dark mode");
    await userEvent.type(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Context"]')!,
      "The settings page is too bright at night.",
    );
    await userEvent.click(
      [...document.querySelectorAll<HTMLElement>("button")].find(
        (button) => button.textContent === "Save to inbox",
      )!,
    );
    await userEvent.click(
      [...document.querySelectorAll<HTMLElement>("button")].find(
        (button) => button.textContent === "Create task",
      )!,
    );

    await vi.waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-5"),
    );
    expect(state.createTask).toHaveBeenCalledWith("env-1", {
      projectId: "busyboy",
      title: "Dark mode",
      context: "The settings page is too bright at night.",
      startPlanning: false,
    });
    // The composer closes once the task exists.
    await vi.waitFor(() =>
      expect(document.querySelector('input[aria-label="Task title"]')).toBeNull(),
    );
  });
  it("folds the PM section from its heading and opens the PM chat from the avatar", async () => {
    const app = renderSidebarApp();
    await app.render();
    await vi.waitFor(() => expect(taskRowButton("BB-3")).not.toBeNull());
    const heading = () =>
      container.querySelector<HTMLElement>('[data-testid="sidebar-project-manager-heading"]')!;
    const toggle = () => heading().querySelector<HTMLElement>("button[aria-expanded]")!;
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(threadRow("BB-2 Fix drag scroll")).not.toBeNull();

    // Clicking the row folds the tasks and threads under it, without opening the PM chat.
    await userEvent.click(toggle());
    await vi.waitFor(() => expect(taskRowButton("BB-3")).toBeNull());
    expect(threadRow("BB-2 Fix drag scroll")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(app.router.state.location.pathname).toBe("/");
    // No chevron: the heading keeps the same look.
    expect(heading().querySelector("svg.lucide-chevron-right")).toBeNull();

    // The fold survives a reload.
    await act(() => root.unmount());
    root = createRoot(container);
    const reloaded = renderSidebarApp();
    await reloaded.render();
    await vi.waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("false"));
    expect(taskRowButton("BB-3")).toBeNull();

    // The avatar opens the PM chat and leaves the fold alone.
    await userEvent.click(
      heading().querySelector<HTMLElement>('button[aria-label="Open Remy chat"]')!,
    );
    await vi.waitFor(() =>
      expect(reloaded.router.state.location.pathname).toBe("/env-1/pm-thread"),
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    // Clicking the row again unfolds it.
    await userEvent.click(toggle());
    await vi.waitFor(() => expect(taskRowButton("BB-3")).not.toBeNull());
    expect(threadRow("BB-2 Fix drag scroll")).not.toBeNull();
  });
});
