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

// One task per status the user sees; only the todo task has no lead yet.
const TASKS: ReadonlyArray<{
  number: number;
  stage: ProjectTaskReference["stage"];
  lead: "running" | null;
  prUrl?: string;
}> = [
  { number: 83, stage: "inbox", lead: null },
  { number: 82, stage: "running", lead: "running" },
  {
    number: 81,
    stage: "in_review",
    lead: "running",
    prUrl: "https://github.com/acme/busyboy/pull/81",
  },
  { number: 80, stage: "done", lead: "running" },
];
const LEAD_TASKS = TASKS.filter((task) => task.lead !== null);

function leadThread(task: (typeof TASKS)[number]): EnvironmentThreadShell {
  const thread = threadShell(
    `lead-${task.number}`,
    "busyboy",
    `2026-11-05T08:${task.number - 60}:00.000Z`,
  );
  return {
    ...thread,
    // The server titles a lead thread with its task's key.
    title: `BU-${task.number} Task ${task.number}`,
    lineage: {
      rootThreadId: "pm-thread",
      parentThreadId: "pm-thread",
      relationshipToParent: "subagent",
    } as never,
    runtime: { status: task.lead, lastErrorClass: null, activeRunId: null } as never,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    ...LEAD_TASKS.map(leadThread),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        taskKeyPrefix: "BU",
        tasks: TASKS.map((task) => ({
          id: `task-${task.number}` as never,
          number: task.number,
          parentTaskId: null,
          waitsOn: [],
          title: `Task ${task.number}`,
          stage: task.stage,
          leadThreadId: task.lead === null ? null : (`lead-${task.number}` as never),
          prUrl: task.prUrl ?? null,
          lastOutcome: null,
          openQuestion: false,
          openBlocker: false,
          iterateRound: 0,
          shipRound: 0,
          modelSteps: {},
          updatedAt: null,
        })),
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

async function renderSidebar() {
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
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  // Task rows show under their PM while its chat is open.
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute, anyRoute]),
    history: createMemoryHistory({ initialEntries: ["/env-1/pm-thread"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
}

function taskKeys(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-task-key"]')];
}

function leadRowTitle(number: number): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]')].find(
    (card) => card.querySelector("span.sr-only")?.textContent === `BU-${number} Task ${number}`,
  );
  if (!row) throw new Error(`No sidebar row for BU-${number}`);
  const title = row.querySelector<HTMLElement>("span[aria-hidden].truncate");
  if (!title) throw new Error(`No title for BU-${number}`);
  return title;
}

async function expectOneKeyStyle() {
  await vi.waitFor(() =>
    expect(
      taskKeys()
        .map((key) => key.textContent)
        .toSorted(),
    ).toEqual(["BU-80", "BU-81", "BU-82", "BU-83"]),
  );
  const styles = taskKeys().map((key) => {
    const style = getComputedStyle(key);
    return { key: key.textContent, fontFamily: style.fontFamily, fontSize: style.fontSize };
  });
  const [first] = styles;
  for (const style of styles) {
    expect(style.fontFamily, style.key ?? "").toBe(first!.fontFamily);
    expect(style.fontSize, style.key ?? "").toBe(first!.fontSize);
  }
  expect(first!.fontFamily).toMatch(/mono/i);
  // Smaller than the title it sits beside.
  expect(Number.parseFloat(first!.fontSize)).toBeLessThan(
    Number.parseFloat(getComputedStyle(leadRowTitle(82)).fontSize),
  );
  // A lead row shows its key once: apart from the title, not inside it.
  for (const task of LEAD_TASKS) {
    expect(leadRowTitle(task.number).textContent).toBe(`Task ${task.number}`);
  }
}

describe("sidebar task keys", () => {
  it("shows every task's key in one small mono style, whatever its status", async () => {
    await renderSidebar();
    await expectOneKeyStyle();
  });

  it("shows every task's key in one style at phone width", async () => {
    await page.viewport(390, 844);
    await renderSidebar();
    await expectOneKeyStyle();
  });
});
