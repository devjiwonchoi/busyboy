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
import { AllProjectsPage, SHOW_DONE_TASKS_STORAGE_KEY } from "./allProjects/AllProjectsPage";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { ThreadSidebarWithRail } from "./sidebar/ThreadSidebarWithRail";
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
    updatedAt: NOW,
    ...overrides,
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(SHOW_DONE_TASKS_STORAGE_KEY);
  localStorage.removeItem("busyboy:sidebar:collapsed-projects");
  state.projects = [project("busyboy", "busyboy"), project("site", "site")];
  state.groups = [projectGroup("busyboy", "busyboy"), projectGroup("site", "site")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    threadShell("pm-site", "site", "2026-11-05T08:59:00.000Z"),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "site" as never,
        pmThreadId: "pm-site" as never,
        taskKeyPrefix: "SI",
        tasks: [task("site-1", 1, "Launch page", { updatedAt: minutesAgo(60 * 24 * 3) })],
      }),
    },
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        taskKeyPrefix: "BB",
        tasks: [
          task("task-1", 1, "Old work", { stage: "done", updatedAt: minutesAgo(60 * 24) }),
          task("task-2", 2, "Fix drag scroll", {
            stage: "in_review",
            prUrl: "https://github.com/acme/busyboy/pull/81",
            updatedAt: minutesAgo(5),
          }),
          task("task-3", 3, "Clean up build warnings", { updatedAt: minutesAgo(90) }),
          task("task-4", 4, "Silence tsc warnings", {
            parentTaskId: "task-3" as never,
            stage: "planning",
            openQuestion: true,
            updatedAt: minutesAgo(30),
          }),
          // Waits on a task in another project that isn't done yet.
          task("task-5", 5, "Wire the launch page", {
            parentTaskId: "task-3" as never,
            waitsOn: ["site-1" as never],
            updatedAt: minutesAgo(45),
          }),
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
  await page.viewport(1280, 800);
});

function renderApp() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        {/* Phones stack the (normally slide-in) sidebar above the page. */}
        <div
          style={{
            display: "flex",
            flexDirection: window.innerWidth < 768 ? "column" : "row",
            width: "100%",
          }}
        >
          <div
            style={{
              width: window.innerWidth < 768 ? "100%" : 320,
              height: window.innerWidth < 768 ? 300 : "100vh",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ThreadSidebarWithRail />
          </div>
          <div style={{ display: "flex", minWidth: 0, flex: 1 }}>
            <Outlet />
          </div>
        </div>
        <MainAppLocationTracker />
      </SidebarProvider>
    ),
  });
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/all-projects",
      component: AllProjectsPage,
    }),
    ...["/", "/$environmentId/$threadId", "/tasks/$environmentId/$projectId/$taskId"].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/env-1/pm-thread"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const rail = () => container.querySelector<HTMLElement>("[data-workspace-rail]")!;
const railEntry = (label: string) =>
  [...rail().querySelectorAll<HTMLElement>("button")].find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent) === label,
  )!;
const row = (id: string) =>
  container.querySelector<HTMLElement>(`[data-all-projects-task="${id}"]`);
const sectionTitles = () =>
  [...container.querySelectorAll("[data-all-projects-section] h2")].map((h) => h.textContent);
const showDoneSwitch = () =>
  page.getByRole("switch", { name: /Show done/ }).element() as HTMLElement;

async function walkThroughAllProjects(app: ReturnType<typeof renderApp>) {
  await app.render();
  await vi.waitFor(() => expect(rail()).not.toBeNull());
  expect(railEntry("Chat").getAttribute("aria-current")).toBe("page");

  // The rail opens All projects.
  await userEvent.click(railEntry("All projects"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/all-projects"));
  await vi.waitFor(() => expect(row("task-2")).not.toBeNull());
  expect(railEntry("All projects").getAttribute("aria-current")).toBe("page");
  expect(railEntry("Chat").getAttribute("aria-current")).toBeNull();

  // Most recently active project first; newest task first, subtasks under their parent.
  expect(sectionTitles()).toEqual(["busyboy", "site"]);
  const ids = [
    ...container.querySelectorAll("[data-all-projects-section='busyboy'] [data-all-projects-task]"),
  ].map((item) => item.getAttribute("data-all-projects-task"));
  expect(ids).toEqual(["task-3", "task-4", "task-5", "task-2"]);

  // Linear-style structure: the parent counts its subtasks, a waiting task an hourglass.
  expect(
    row("task-3")!.querySelector("[data-subtask-progress]")!.getAttribute("data-subtask-progress"),
  ).toBe("0/2");
  expect(row("task-5")!.getAttribute("data-blocked")).toBe("true");
  expect(row("task-4")!.getAttribute("data-blocked")).toBeNull();
  if (window.innerWidth < 640) {
    // No hover on a phone: the row names the blocker itself.
    const label = row("task-5")!.querySelector<HTMLElement>("[data-blocked-label]")!;
    expect(label.offsetParent).not.toBeNull();
    expect(label.textContent).toBe("SI-1 끝나야 시작");
    expect(label.querySelector(".lucide-hourglass")).not.toBeNull();
  } else {
    expect(
      row("task-5")!.querySelector<HTMLElement>("[data-blocked-label]")!.offsetParent,
    ).toBeNull();
    const marker = row("task-5")!.querySelector<HTMLElement>("[data-waiting-marker]")!;
    expect(marker.querySelector("[aria-hidden]")?.textContent).toBe("SI-1");
    await userEvent.hover(row("task-5")!.querySelector("[data-testid='waiting-marker-trigger']")!);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("SI-1 끝나야 시작 · Launch page"),
    );
    await userEvent.unhover(
      row("task-5")!.querySelector("[data-testid='waiting-marker-trigger']")!,
    );
  }

  expect(container.querySelector(".lucide-flag")).toBeNull();

  // Each row: status, key, title, PR link and last update.
  expect(row("task-2")!.textContent).toContain("BB-2");
  expect(row("task-2")!.textContent).toContain("Fix drag scroll");
  // In review with no lead turn running is Ready; the PR shows in its own column.
  expect(row("task-2")!.getAttribute("data-task-status")).toBe("ready");
  expect(row("task-2")!.textContent).toContain("Ready");
  expect(row("task-2")!.textContent).toContain("5m ago");
  const pr = row("task-2")!.querySelector<HTMLAnchorElement>("a[href^='https://github.com']")!;
  expect(pr.textContent).toBe("PR #81");
  expect(pr.href).toBe("https://github.com/acme/busyboy/pull/81");
  expect(row("task-4")!.getAttribute("data-task-status")).toBe("ask_question");
  expect(row("task-4")!.textContent).toContain("30m ago");
  expect(row("site-1")!.textContent).toContain("3d ago");

  // Done tasks are archived: hidden until the toggle, which is remembered.
  expect(row("task-1")).toBeNull();
  expect(container.textContent).toContain("Show done (1)");
  await userEvent.click(showDoneSwitch());
  await vi.waitFor(() => expect(row("task-1")).not.toBeNull());
  expect(row("task-1")!.textContent).toContain("Done");
  expect(localStorage.getItem(SHOW_DONE_TASKS_STORAGE_KEY)).toBe("true");
  await userEvent.click(showDoneSwitch());
  await vi.waitFor(() => expect(row("task-1")).toBeNull());

  // Clicking a row opens its task page.
  await userEvent.click(row("task-3")!.querySelector("a")!);
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-3"),
  );
  expect(railEntry("Chat").getAttribute("aria-current")).toBe("page");

  // Chat goes back to the last chat page, from All projects.
  await userEvent.click(railEntry("All projects"));
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/all-projects"));
  await userEvent.click(railEntry("Chat"));
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-3"),
  );
}

describe("All projects", () => {
  it("opens from the rail and lists every project's tasks on desktop", async () => {
    await page.viewport(1280, 800);
    const app = renderApp();
    await walkThroughAllProjects(app);
    expect(rail().getAttribute("data-workspace-rail")).toBe("column");
    // Desktop rows stay one line, Linear-style.
    await userEvent.click(railEntry("All projects"));
    await vi.waitFor(() => expect(row("task-2")).not.toBeNull());
    expect(getComputedStyle(row("task-2")!.querySelector("a")!).whiteSpace).toBe("nowrap");
  });

  it("works as tabs on a phone, with rows that wrap instead of clipping", async () => {
    await page.viewport(390, 844);
    const app = renderApp();
    await app.render();
    await vi.waitFor(() => expect(rail()).not.toBeNull());
    expect(rail().getAttribute("data-workspace-rail")).toBe("tabs");
    expect(railEntry("All projects").textContent).toBe("All projects");
    await act(() => root.unmount());
    root = createRoot(container);
    await walkThroughAllProjects(renderApp());
    // The title gets its own line, so a long title is not squeezed by the details.
    await userEvent.click(railEntry("All projects"));
    await vi.waitFor(() => expect(row("task-2")).not.toBeNull());
    const title = row("task-2")!.querySelector("a")!;
    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
    // Long titles wrap on phones rather than ending in "…".
    expect(getComputedStyle(title).whiteSpace).not.toBe("nowrap");
  });
});
