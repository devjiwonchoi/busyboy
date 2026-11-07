import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTaskReference, ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The Director: the workspace-wide PM in a hidden system project. Its epics
// group tasks from every project; its card and rail avatar sit above them.

const NOW = "2026-11-05T09:00:00.000Z";

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  createTask: (() => undefined) as unknown as (...args: unknown[]) => Promise<unknown>,
  startTurn: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
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
  useThreadShell: ((ref: { threadId: string } | null) =>
    ref === null
      ? null
      : ((state.threads as { id: string }[]).find((thread) => thread.id === ref.threadId) ??
        null)) as never,
}));
vi.mock(import("../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => state.startTurn) as never,
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
import { AllProjectsPage, SHOW_DONE_TASKS_STORAGE_KEY } from "./allProjects/AllProjectsPage";
import { QuickTaskHost } from "./task/QuickTaskHost";
import { closeQuickTask, openQuickTask } from "./task/quickTaskStore";
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
    updatedAt: NOW,
    ...overrides,
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(SHOW_DONE_TASKS_STORAGE_KEY);
  localStorage.removeItem("busyboy:sidebar:collapsed-projects");
  state.startTurn.mockClear();
  state.projects = [
    project("busyboy", "busyboy"),
    project("site", "site"),
    project("director", "Director"),
  ];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    threadShell("pm-site", "site", "2026-11-05T08:59:00.000Z"),
    threadShell("director-thread", "director", "2026-11-05T08:59:30.000Z"),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "director" as never,
        pmThreadId: "director-thread" as never,
        kind: "director",
        persona: { name: "Atlas", avatar: { kind: "emoji", emoji: "🧭" }, voice: "chill" },
        taskKeyPrefix: "DI",
        openCount: 2,
        lastMessage: {
          role: "assistant",
          text: "Launch is on track: site page ready, busyboy wiring waits on it.",
          at: NOW,
        },
        tasks: [
          task("epic-1", 1, "Launch v1", { stage: "running" }),
          task("epic-0", 2, "Old epic", { stage: "done" }),
        ],
      }),
    },
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "site" as never,
        pmThreadId: "pm-site" as never,
        taskKeyPrefix: "SI",
        tasks: [
          task("site-1", 1, "Launch page", {
            stage: "done",
            parentTaskId: "epic-1" as never,
            updatedAt: minutesAgo(60),
          }),
        ],
      }),
    },
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        taskKeyPrefix: "BB",
        tasks: [
          task("task-1", 1, "Wire the launch page", {
            stage: "running",
            parentTaskId: "epic-1" as never,
            updatedAt: minutesAgo(5),
          }),
          task("task-2", 2, "Unrelated fix", { updatedAt: minutesAgo(10) }),
        ],
      }),
    },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => closeQuickTask());
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

function renderApp() {
  const phone = window.innerWidth < 768;
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <div style={{ display: "flex", flexDirection: phone ? "column" : "row", width: "100%" }}>
          <div
            style={{
              width: phone ? "100%" : 320,
              height: phone ? 300 : "100vh",
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
        <QuickTaskHost />
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
const directorAvatar = () => rail().querySelector<HTMLElement>("[data-director-rail]")!;
const card = () => container.querySelector<HTMLElement>("[data-director-card]");
const epicIds = () =>
  [...container.querySelectorAll("[data-all-projects-epics] [data-all-projects-task]")].map(
    (item) => item.getAttribute("data-all-projects-task"),
  );
const sectionTitles = () =>
  [...container.querySelectorAll("[data-all-projects-section] h2")].map((h) => h.textContent);

async function walkThroughDirector(app: ReturnType<typeof renderApp>) {
  await app.render();
  await vi.waitFor(() => expect(rail()).not.toBeNull());

  // The Director's system project and chat stay out of the sidebar's project list.
  await vi.waitFor(() => expect(container.textContent).toContain("busyboy"));
  expect(
    [...container.querySelectorAll("[data-testid='sidebar-project-header']")].map(
      (header) => header.textContent,
    ),
  ).not.toEqual(expect.arrayContaining([expect.stringContaining("Director")]));

  // The rail's Director avatar shows what it waits on and opens its chat.
  expect(directorAvatar().getAttribute("aria-label")).toBe("Atlas, 2 waiting");
  await userEvent.click(directorAvatar());
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/director-thread"));
  expect(directorAvatar().getAttribute("aria-current")).toBe("page");
  expect(railEntry("Chat").getAttribute("aria-current")).toBeNull();

  // All projects: the Director's card on top, with its digest and waiting actions.
  await userEvent.click(railEntry("All projects"));
  await vi.waitFor(() => expect(card()).not.toBeNull());
  expect(directorAvatar().getAttribute("aria-current")).toBeNull();
  expect(card()!.querySelector("[data-director-digest]")!.textContent).toContain(
    "Launch is on track",
  );
  expect(card()!.querySelector("[data-director-waiting]")!.textContent).toBe("2 actions waiting");
  expect(card()!.textContent).toContain("2 projects · 1 in progress");

  // Epics group their subtasks from every project, with each project's key.
  expect(epicIds()).toEqual(["epic-1", "task-1"]);
  const epicRow = container.querySelector<HTMLElement>(
    "[data-all-projects-epics] [data-all-projects-task='epic-1']",
  )!;
  expect(epicRow.textContent).toContain("DI-1");
  expect(
    epicRow.querySelector("[data-subtask-progress]")!.getAttribute("data-subtask-progress"),
  ).toBe("1/2");
  expect(
    container.querySelector("[data-all-projects-epics] [data-all-projects-task='task-1']")!
      .textContent,
  ).toContain("BB-1");
  // Show done brings back finished epics and subtasks.
  await userEvent.click(page.getByRole("switch", { name: /Show done/ }).element() as HTMLElement);
  await vi.waitFor(() => expect(epicIds()).toEqual(["epic-1", "site-1", "task-1", "epic-0"]));
  await userEvent.click(page.getByRole("switch", { name: /Show done/ }).element() as HTMLElement);
  await vi.waitFor(() => expect(epicIds()).toEqual(["epic-1", "task-1"]));

  // The Director is not a project section.
  expect(sectionTitles()).not.toContain("Director");
  expect(sectionTitles()).toEqual(expect.arrayContaining(["busyboy", "site"]));

  // Clicking an epic's subtask opens it in its own project.
  await userEvent.click(
    container.querySelector("[data-all-projects-epics] [data-all-projects-task='task-1'] a")!,
  );
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-1"),
  );

  // Messaging the Director from the card sends to its chat and opens it.
  await userEvent.click(railEntry("All projects"));
  await vi.waitFor(() => expect(card()).not.toBeNull());
  const input = page.getByRole("textbox", { name: "Message Atlas" });
  await userEvent.click(input);
  await userEvent.keyboard("Ship the launch this week");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(state.startTurn).toHaveBeenCalledTimes(1));
  expect(state.startTurn.mock.calls[0]![0]).toMatchObject({
    environmentId: "env-1",
    input: {
      threadId: "director-thread",
      message: { role: "user", text: "Ship the launch this week" },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
  });
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/director-thread"));

  // Chat returns to the last ordinary chat page, not the Director's.
  await userEvent.click(railEntry("Chat"));
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-1"),
  );

  // New tasks are planned in a project, never in the Director's.
  await act(async () => openQuickTask());
  await vi.waitFor(() => expect(document.querySelector("[role='dialog']")).not.toBeNull());
  expect(document.querySelector("[role='dialog']")!.textContent).not.toContain("Director");
}

describe("Director", () => {
  it("rail avatar, All projects card, composer and epics on desktop", async () => {
    await page.viewport(1280, 800);
    const app = renderApp();
    await walkThroughDirector(app);
    expect(rail().getAttribute("data-workspace-rail")).toBe("column");
  });

  it("works the same on a phone", async () => {
    await page.viewport(390, 844);
    const app = renderApp();
    await walkThroughDirector(app);
    expect(rail().getAttribute("data-workspace-rail")).toBe("tabs");
    // The avatar sits in the tab row, a comfortable tap target.
    const box = directorAvatar().getBoundingClientRect();
    expect(box.height).toBeGreaterThanOrEqual(36);
  });
});
