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

// One task lead per user-facing status, plus the stored states that fold into one.
type LeadRuntime = "running" | "failed";
const TASKS: ReadonlyArray<{
  number: number;
  stage: ProjectTaskReference["stage"];
  prUrl?: string;
  lastOutcome?: ProjectTaskReference["lastOutcome"];
  openQuestion?: boolean;
  openBlocker?: boolean;
  ready?: boolean;
  lead?: LeadRuntime;
}> = [
  { number: 1, stage: "inbox" },
  { number: 2, stage: "planning" },
  { number: 3, stage: "awaiting_approval" },
  { number: 4, stage: "running", lead: "running" },
  {
    number: 5,
    stage: "in_review",
    prUrl: "https://github.com/acme/busyboy/pull/81",
    lead: "running",
  },
  // Ready comes from the server's Ready gate, not from an idle lead.
  {
    number: 6,
    stage: "in_review",
    prUrl: "https://github.com/acme/busyboy/pull/82",
    lastOutcome: "ready",
    ready: true,
  },
  { number: 7, stage: "planning", openQuestion: true },
  { number: 8, stage: "running", lead: "failed" },
  { number: 9, stage: "done" },
  { number: 10, stage: "cancelled" },
  { number: 11, stage: "running", lastOutcome: "stalled" },
  { number: 12, stage: "blocked" },
  // The PM's nudges ran out and raised a blocker card.
  { number: 13, stage: "running", lastOutcome: "stalled", openQuestion: true, openBlocker: true },
];

function leadThread(task: (typeof TASKS)[number]): EnvironmentThreadShell {
  const thread = threadShell(
    `lead-${task.number}`,
    "busyboy",
    `2026-11-05T08:${10 + task.number}:00.000Z`,
  );
  return {
    ...thread,
    title: `Task ${task.number}`,
    // Task 4's lead runs in a cloud sandbox; the rest run locally.
    ...(task.number === 4 ? { location: "cloud" as const } : {}),
    lineage: {
      rootThreadId: "pm-thread",
      parentThreadId: "pm-thread",
      relationshipToParent: "subagent",
    } as never,
    runtime:
      task.lead === undefined
        ? null
        : ({ status: task.lead, lastErrorClass: null, activeRunId: null } as never),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    ...TASKS.map(leadThread),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        tasks: TASKS.map((task) => ({
          id: `task-${task.number}` as never,
          number: task.number,
          parentTaskId: null,
          waitsOn: [],
          title: `Task ${task.number}`,
          stage: task.stage,
          leadThreadId: `lead-${task.number}` as never,
          // Task 4's lead runs in a cloud sandbox; the rest run locally.
          location: task.number === 4 ? "cloud" : "local",
          prUrl: task.prUrl ?? null,
          lastOutcome: task.lastOutcome ?? null,
          openQuestion: task.openQuestion ?? false,
          openBlocker: task.openBlocker ?? false,
          iterateRound: 0,
          shipRound: 0,
          ...(task.ready === undefined ? {} : { ready: task.ready }),
          modelSteps: {},
          updatedAt: null,
        })),
        // Task 7 asked the user a question.
        decisionCards: [
          {
            taskNumber: 7,
            taskTitle: "Task 7",
            plan: null,
            item: {
              id: "attention-7" as never,
              projectId: "busyboy" as never,
              taskId: "task-7" as never,
              kind: "decision",
              question: "Which login provider?",
              options: [],
              answer: null,
              answeredAt: null,
              askerThreadId: "lead-7" as never,
              batchId: "batch-1" as never,
              createdAt: NOW as never,
              supersededAt: null,
              answeredBy: null,
              specVersion: null,
              summary: null,
              verification: null,
              details: null,
              senderRole: null,
              senderName: null,
            },
          },
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
        {/* Real width, so the row titles can be hovered. */}
        <div style={{ width: 320, flexShrink: 0 }}>
          <Sidebar />
        </div>
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
    history: createMemoryHistory({ initialEntries: ["/env-1/pm-thread"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

function taskRow(number: number): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]')].find(
    (card) => card.querySelector("span.sr-only")?.textContent === `Task ${number}`,
  );
  if (!row) throw new Error(`No sidebar row for task ${number}`);
  return row;
}

function rowStatus(number: number) {
  const slot = taskRow(number).querySelector<HTMLElement>('[data-testid="sidebar-row-status"]');
  return {
    icon: slot?.dataset.status ?? null,
    label: slot?.querySelector('[role="status"]')?.textContent ?? null,
    rowLabel: taskRow(number).getAttribute("aria-label"),
  };
}

const EXPECTED: Record<number, { icon: string; label: string }> = {
  1: { icon: "task-todo", label: "Todo" },
  2: { icon: "task-planning", label: "Planning" },
  3: { icon: "task-waiting_for_approval", label: "Waiting for approval" },
  4: { icon: "task-in_progress", label: "In Progress" },
  5: { icon: "task-in_review", label: "In Review · PR #81" },
  6: { icon: "task-ready", label: "Ready · PR #82" },
  7: { icon: "task-ask_question", label: "Ask question" },
  8: { icon: "task-fatal", label: "Fatal" },
  9: { icon: "task-done", label: "Done" },
  10: { icon: "task-done", label: "Done · cancelled" },
  // A quiet turn is normal work: In Progress, with the idle hint in the label.
  11: { icon: "task-in_progress", label: "In Progress · idle" },
  12: { icon: "task-fatal", label: "Fatal" },
  13: { icon: "task-fatal", label: "Fatal" },
};

async function expectEveryStatus() {
  await vi.waitFor(() => expect(rowStatus(1).icon).toBe("task-todo"));
  for (const [number, { icon, label }] of Object.entries(EXPECTED)) {
    const status = rowStatus(Number(number));
    expect(status.icon, `task ${number}`).toBe(icon);
    expect(status.label, `task ${number}`).toBe(label);
    // Screen readers hear the status as part of the row.
    expect(status.rowLabel, `task ${number}`).toContain(label);
  }
}

describe("sidebar task status", () => {
  it("shows one status icon and label per task, the same for every stage that maps to it", async () => {
    await renderSidebarApp().render();
    await expectEveryStatus();
  });

  it("shows every status at phone width", async () => {
    await page.viewport(390, 844);
    await renderSidebarApp().render();
    await expectEveryStatus();
    const icon = taskRow(6).querySelector<HTMLElement>('[data-testid="sidebar-row-status"] svg');
    expect(icon?.getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it("shows the task's status in a tooltip when hovering its title", async () => {
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(5).icon).toBe("task-in_review"));

    const title = taskRow(5).querySelector<HTMLElement>("span[aria-hidden]")!;
    await userEvent.hover(title);
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="sidebar-task-status-tooltip"]')?.textContent,
      ).toBe("In Review · PR #81"),
    );
  });

  it("marks only a cloud thread's row with a quiet cloud icon", async () => {
    // Task 5 was cloud once but its lead was restarted locally: the thread's own location wins.
    state.managers = state.managers.map((manager) => ({
      ...manager,
      summary: {
        ...manager.summary,
        tasks: manager.summary.tasks.map((task) =>
          task.number === 5 ? { ...task, location: "cloud" as const } : task,
        ),
      },
    }));
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(4).icon).toBe("task-in_progress"), { timeout: 3000 });
    const cloud = taskRow(4).querySelector<SVGElement>('[data-cloud-badge="icon"]');
    expect(cloud?.getAttribute("aria-label")).toBe("Runs in a cloud sandbox");
    expect(cloud?.getBoundingClientRect().width).toBeGreaterThan(0);
    for (const number of [1, 2, 5, 9]) {
      expect(taskRow(number).querySelector("[data-cloud-badge]"), `task ${number}`).toBeNull();
    }
  });

  it("marks a cloud delegate child that leads no task with the cloud icon", async () => {
    const child = threadShell("cloud-child", "busyboy", "2026-11-05T08:30:00.000Z");
    state.threads.push(
      { ...child, location: "cloud" },
      threadShell("local-child", "busyboy", "2026-11-05T08:29:00.000Z"),
    );
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(1).icon).toBe("task-todo"));
    const row = (title: string) =>
      [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]')].find(
        (card) => card.querySelector("span.sr-only")?.textContent === title,
      );
    expect(row("cloud-child")?.querySelector('[data-cloud-badge="icon"]')).not.toBeNull();
    expect(row("local-child")).toBeDefined();
    expect(row("local-child")?.querySelector("[data-cloud-badge]")).toBeNull();
  });

  it("leaves ordinary thread rows without a task status", async () => {
    state.threads.push(threadShell("plain", "busyboy", "2026-11-05T08:00:00.000Z"));
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(1).icon).toBe("task-todo"));
    const plain = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]'),
    ].find((card) => card.querySelector("span.sr-only")?.textContent === "plain");
    expect(
      plain?.querySelector('[data-testid="sidebar-row-status"]')?.getAttribute("data-status"),
    ).toBeNull();
  });
});
