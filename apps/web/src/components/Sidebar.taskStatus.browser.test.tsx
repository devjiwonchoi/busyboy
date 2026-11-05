import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
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

// One task lead per stage, plus the sub-states that matter.
const TASKS = [
  { number: 1, stage: "inbox" },
  { number: 2, stage: "planning" },
  { number: 3, stage: "running" },
  { number: 4, stage: "in_review", prUrl: "https://github.com/acme/busyboy/pull/81" },
  { number: 5, stage: "done" },
  { number: 6, stage: "blocked" },
  { number: 7, stage: "cancelled" },
  { number: 8, stage: "running", lastOutcome: "stalled" },
  { number: 9, stage: "planning" },
] as const;

function leadThread(number: number): EnvironmentThreadShell {
  const thread = threadShell(`lead-${number}`, "busyboy", `2026-11-05T08:${10 + number}:00.000Z`);
  return {
    ...thread,
    title: `Task ${number}`,
    lineage: {
      rootThreadId: "pm-thread",
      parentThreadId: "pm-thread",
      relationshipToParent: "subagent",
    } as never,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    ...TASKS.map((task) => leadThread(task.number)),
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        tasks: TASKS.map((task) => ({
          number: task.number,
          title: `Task ${task.number}`,
          stage: task.stage,
          leadThreadId: `lead-${task.number}` as never,
          prUrl: "prUrl" in task ? task.prUrl : null,
          lastOutcome: "lastOutcome" in task ? task.lastOutcome : null,
        })),
        // Task 9 asked the user to approve its plan.
        decisionCards: [
          {
            taskNumber: 9,
            taskTitle: "Task 9",
            item: {
              id: "attention-9" as never,
              projectId: "busyboy" as never,
              taskId: "task-9" as never,
              kind: "approval",
              question: "Approve the plan?",
              options: [],
              answer: null,
              answeredAt: null,
              askerThreadId: "lead-9" as never,
              batchId: "batch-1" as never,
              createdAt: NOW as never,
              supersededAt: null,
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
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

describe("sidebar task status", () => {
  it("shows a status icon and label on every task row, whatever its stage", async () => {
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(1).icon).toBe("inbox"));

    const expected: Record<number, { icon: string; label: string }> = {
      1: { icon: "inbox", label: "Inbox" },
      2: { icon: "planning", label: "Planning" },
      3: { icon: "running", label: "Running" },
      4: { icon: "review", label: "In review · PR #81" },
      5: { icon: "done", label: "Done" },
      6: { icon: "blocked", label: "Blocked" },
      7: { icon: "cancelled", label: "Cancelled" },
      8: { icon: "stalled", label: "Stalled · Running" },
      9: { icon: "input", label: "Needs you" },
    };
    for (const [number, { icon, label }] of Object.entries(expected)) {
      const status = rowStatus(Number(number));
      expect(status.icon, `task ${number}`).toBe(icon);
      expect(status.label, `task ${number}`).toBe(label);
      // Screen readers hear the status as part of the row.
      expect(status.rowLabel, `task ${number}`).toContain(label);
    }
  });

  it("shows the in-review task's PR in a tooltip when hovering its title", async () => {
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(4).icon).toBe("review"));

    const title = taskRow(4).querySelector<HTMLElement>("span[aria-hidden]")!;
    await userEvent.hover(title);
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="sidebar-task-status-tooltip"]')?.textContent,
      ).toBe("In review · PR #81"),
    );
  });

  it("leaves ordinary thread rows without a task status", async () => {
    state.threads.push(threadShell("plain", "busyboy", "2026-11-05T08:00:00.000Z"));
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(rowStatus(1).icon).toBe("inbox"));
    const plain = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]'),
    ].find((card) => card.querySelector("span.sr-only")?.textContent === "plain");
    expect(
      plain?.querySelector('[data-testid="sidebar-row-status"]')?.getAttribute("data-status"),
    ).toBeNull();
  });
});
