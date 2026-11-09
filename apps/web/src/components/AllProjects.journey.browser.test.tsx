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
import { DirectorWorkspaceSurface } from "./director/DirectorWorkspaceSurface";
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

function decisionCard(id: string, kind: "approval" | "decision", createdAt: string) {
  return {
    taskNumber: 3,
    taskTitle: "Clean up build warnings",
    plan: null,
    item: {
      id: id as never,
      projectId: "busyboy" as never,
      taskId: "task-3" as never,
      kind,
      question: "?",
      options: [],
      answer: null,
      answeredAt: null,
      askerThreadId: null,
      batchId: "batch" as never,
      createdAt,
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
        presence: { running: 1 },
        tasks: [
          task("site-1", 1, "Launch page", {
            checks: [{ text: "페이지가 열린다", passed: false }],
            updatedAt: minutesAgo(60 * 24 * 3),
          }),
          // Waits on a goal in another project: an arrow on desktop, a line on phones.
          task("site-2", 2, "Wire the map", {
            stage: "running",
            checks: [],
            waitsOn: ["task-3" as never],
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
        direction: "어려운 프로젝트에서도 자동으로 높은 기준",
        presence: { running: 2 },
        decisionCards: [
          decisionCard("card-1", "approval", minutesAgo(20)),
          decisionCard("card-2", "decision", minutesAgo(10)),
        ],
        tasks: [
          task("task-0", 10, "Dropped idea", { stage: "cancelled", checks: [] }),
          task("task-1", 1, "Old work", {
            stage: "done",
            checks: [{ text: "old", passed: true }],
            updatedAt: minutesAgo(60 * 24 * 8),
          }),
          task("task-2", 2, "Fix drag scroll", {
            stage: "in_review",
            prUrl: "https://github.com/acme/busyboy/pull/81",
            checks: [
              { text: "끌어서 스크롤된다", passed: true },
              { text: "폰에서도", passed: true },
            ],
            updatedAt: minutesAgo(5),
          }),
          task("task-3", 3, "Clean up build warnings", {
            stage: "running",
            checks: [
              { text: "경고 0개", passed: true },
              { text: "CI 통과", passed: false },
            ],
            updatedAt: minutesAgo(90),
          }),
          task("task-4", 4, "Silence tsc warnings", {
            parentTaskId: "task-3" as never,
            stage: "planning",
            openQuestion: true,
            checks: null,
            updatedAt: minutesAgo(30),
          }),
          task("task-6", 6, "Docs refresh", { stage: "planning", checks: [] }),
          task("task-7", 7, "Recently shipped", {
            stage: "done",
            checks: [{ text: "출시됨", passed: true }],
            updatedAt: minutesAgo(60 * 24),
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
        <div style={{ display: "flex", width: "100%" }}>
          <Outlet />
        </div>
      </SidebarProvider>
    ),
  });
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/all-projects",
      component: DirectorWorkspaceSurface,
    }),
    ...["/", "/$environmentId/$threadId", "/tasks/$environmentId/$projectId/$taskId"].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/all-projects"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const card = (projectId: string) =>
  container.querySelector<HTMLElement>(`[data-project-card="${projectId}"]`)!;
const goal = (projectId: string, taskId: string) =>
  card(projectId).querySelector<HTMLElement>(`[data-goal="${taskId}"]`);
const goalIds = (projectId: string) =>
  [...card(projectId).querySelectorAll("[data-goal]")].map((item) =>
    item.getAttribute("data-goal"),
  );
const arrowsSvg = () => container.querySelector<SVGElement>("[data-map-arrows]");
const isShown = (element: Element) => getComputedStyle(element).display !== "none";

async function walkThroughAllProjects(app: ReturnType<typeof renderApp>) {
  const phone = window.innerWidth < 640;
  await app.render();
  await userEvent.click(page.getByRole("button", { name: "지도", exact: true }));
  await vi.waitFor(() => expect(container.querySelector("[data-project-card]")).not.toBeNull());

  // One card per project; the one waiting on the user first.
  const cards = [...container.querySelectorAll<HTMLElement>("[data-project-card]")];
  expect(cards.map((item) => item.getAttribute("data-project-card"))).toEqual(["busyboy", "site"]);
  // Desktop lays cards side by side, a phone stacks them.
  const [first, second] = cards.map((item) => item.getBoundingClientRect());
  if (phone) {
    expect(second!.left).toBe(first!.left);
    expect(second!.top).toBeGreaterThan(first!.bottom);
  } else {
    expect(second!.left).toBeGreaterThan(first!.right);
  }

  // The task list is gone: no task rows, epics or Show done toggle.
  expect(container.querySelector("[data-all-projects-task]")).toBeNull();
  expect(container.querySelector("[data-all-projects-epics]")).toBeNull();
  expect(container.textContent).not.toContain("Show done");

  // Head, direction, progress, now / next / needs-you.
  const busyboy = card("busyboy");
  expect(busyboy.textContent).toContain("● 작업 중 2");
  expect(busyboy.querySelector("[data-project-direction]")!.textContent).toBe(
    "어려운 프로젝트에서도 자동으로 높은 기준",
  );
  // Cancelled and week-old goals are gone; the planning goal adds no checks.
  expect(busyboy.querySelector("[data-project-progress]")!.textContent).toContain("체크 4/5 통과");
  expect(busyboy.querySelector("[data-project-progress]")!.textContent).toContain("80%");
  expect(busyboy.querySelector("[data-project-now]")!.textContent).toBe(
    "Fix drag scroll · Clean up build warnings",
  );
  expect(busyboy.querySelector("[data-project-next]")!.textContent).toBe("Docs refresh");
  expect(busyboy.querySelector("[data-project-needs-you]")!.textContent).toBe(
    "플랜 승인 1 · 질문 1 →",
  );
  expect(card("site").querySelector("[data-project-direction]")!.textContent).toBe(
    "방향 미정 — PM에게 알려주세요",
  );
  expect(card("site").querySelector("[data-project-needs-you]")!.textContent).toBe("—");

  // Goals: in progress, then planning, then done (struck through). Phones show two at first.
  const allGoals = ["task-2", "task-3", "task-6", "task-7"];
  if (phone) {
    expect(goalIds("busyboy")).toEqual(allGoals.slice(0, 2));
    await userEvent.click(busyboy.querySelector<HTMLElement>("[data-goals-more]")!);
    await vi.waitFor(() => expect(goalIds("busyboy")).toEqual(allGoals));
  } else {
    expect(goalIds("busyboy")).toEqual(allGoals);
    expect(busyboy.querySelector("[data-goals-more]")).toBeNull();
  }
  expect(goal("busyboy", "task-6")!.textContent).toContain("계획 중");
  // In progress but no checks yet: still marked as being planned.
  expect(goal("site", "site-2")!.textContent).toContain("계획 중");
  expect(goal("busyboy", "task-3")!.textContent).toContain("1/2");
  expect(
    getComputedStyle(goal("busyboy", "task-7")!.querySelector("span.line-through")!)
      .textDecorationLine,
  ).toBe("line-through");

  // Waiting on another project: an arrow on desktop, a line on the card everywhere.
  const waiting = card("site").querySelector<HTMLElement>("[data-waiting-line]")!;
  expect(waiting.textContent).toBe("⏳ busyboy · Clean up build warnings 기다리는 중");
  expect(waiting.offsetParent).not.toBeNull();
  await vi.waitFor(() => expect(arrowsSvg()).not.toBeNull());
  const arrow = arrowsSvg()!.querySelector("[data-map-arrow]")!;
  expect(arrow.getAttribute("data-from")).toBe("site-2");
  expect(arrow.getAttribute("data-to")).toBe("task-3");
  expect(arrow.getAttribute("stroke-dasharray")).toBe("5 4");
  expect(isShown(arrowsSvg()!)).toBe(!phone);

  // A goal unfolds into its checklist, which links to the task page.
  await userEvent.click(goal("busyboy", "task-3")!.querySelector("button")!);
  await vi.waitFor(() =>
    expect(goal("busyboy", "task-3")!.querySelector("[data-goal-checklist]")).not.toBeNull(),
  );
  const checklist = goal("busyboy", "task-3")!.querySelector<HTMLElement>("[data-goal-checklist]")!;
  expect([...checklist.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "✓ 경고 0개",
    "○ CI 통과",
  ]);
  await userEvent.click(page.getByRole("link", { name: "열기 →" }).element() as HTMLElement);
  await vi.waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/busyboy/task-3"),
  );
  await act(async () => {
    await app.router.navigate({ to: "/all-projects" });
  });
  await userEvent.click(page.getByRole("button", { name: "지도", exact: true }));

  // A project's name opens its PM chat.
  await vi.waitFor(() => expect(container.querySelector("[data-project-card]")).not.toBeNull());
  await userEvent.click(
    card("site").querySelector<HTMLElement>("[data-project-card-head] button")!,
  );
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-site"));
}

describe("All projects", () => {
  it("shows every project as a card on the map on desktop", async () => {
    await page.viewport(1280, 800);
    const app = renderApp();
    await walkThroughAllProjects(app);
  });

  it("stacks the same cards on a phone, with waiting lines instead of arrows", async () => {
    await page.viewport(390, 844);
    const app = renderApp();
    await walkThroughAllProjects(app);
  });
});
