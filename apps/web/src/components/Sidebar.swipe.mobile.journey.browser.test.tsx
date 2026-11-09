import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
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
  archiveThread: vi.fn(),
  pinThread: vi.fn(),
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => state.threads) as never,
  useProjects: (() => state.projects) as never,
  useServerConfigs: (() =>
    new Map([["env-1", { environment: { capabilities: { threadPinning: true } } }]])) as never,
  useEnvironmentIdentities: (() => []) as never,
}));
vi.mock(import("../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: (() => state.groups) as never,
}));
vi.mock(import("../hooks/useThreadActions"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useThreadActions: (() => ({
      ...actual.useThreadActions(),
      archiveThread: state.archiveThread,
      pinThread: state.pinThread,
    })) as never,
  };
});
vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => state.managers) as never,
  useEnvironmentProjectTeamAttention: (() => ({
    byProjectId: new Map(state.managers.map((m) => [m.summary.projectId, m.summary])),
    byPmThreadId: new Map(state.managers.map((m) => [m.summary.pmThreadId, m.summary])),
  })) as never,
  useRequestSitrep: (() => vi.fn()) as never,
  useLeadThreadTask: (() => null) as never,
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.archiveThread.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.pinThread.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    threadShell("idle", "busyboy", "2026-11-05T08:50:00.000Z"),
    {
      ...threadShell("busy", "busyboy", "2026-11-05T08:40:00.000Z"),
      runtime: { status: "running", lastErrorClass: null, activeRunId: "run-1" } as never,
    },
  ];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
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
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

function row(title: string): HTMLElement {
  const card = [
    ...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]'),
  ].find((candidate) => candidate.querySelector("span.sr-only")?.textContent === title);
  if (!card) throw new Error(`No sidebar row for ${title}`);
  return card;
}

function trayOf(title: string): HTMLElement | null {
  return row(title)
    .closest("li")!
    .querySelector<HTMLElement>('[data-testid="sidebar-row-swipe-actions"]');
}

/** A one-finger swipe across the row, as a phone reports it. */
async function swipe(target: HTMLElement, dx: number, dy = 0) {
  const box = target.getBoundingClientRect();
  const x = box.right - 20;
  const y = box.top + box.height / 2;
  const init = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true };
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent("pointerdown", { ...init, clientX: x, clientY: y, buttons: 1 }),
    );
    for (let step = 1; step <= 6; step += 1) {
      target.dispatchEvent(
        new PointerEvent("pointermove", {
          ...init,
          clientX: x + (dx * step) / 6,
          clientY: y + (dy * step) / 6,
          buttons: 1,
        }),
      );
    }
    target.dispatchEvent(
      new PointerEvent("pointerup", { ...init, clientX: x + dx, clientY: y + dy }),
    );
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x + dx, clientY: y }));
  });
}

describe("phone: swipe a sidebar row", () => {
  beforeEach(async () => {
    await page.viewport(390, 844);
  });

  it("reveals Pin and Archive, and Archive archives the thread", async () => {
    const router = await renderSidebar();
    await vi.waitFor(() => row("idle"));

    await swipe(row("idle"), -100);
    const tray = trayOf("idle");
    expect(tray).not.toBeNull();
    const labels = [...tray!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Pin", "Archive"]);
    // The swipe itself does not open the thread.
    expect(router.state.location.pathname).toBe("/env-1/pm-thread");

    await act(async () =>
      tray!.querySelector<HTMLButtonElement>('button[aria-label="Archive thread"]')!.click(),
    );
    await vi.waitFor(() => expect(state.archiveThread).toHaveBeenCalledTimes(1));
    expect(state.archiveThread.mock.calls[0]![0]).toMatchObject({ threadId: "idle" });
    expect(trayOf("idle")).toBeNull();
  });

  it("pins from the tray", async () => {
    await renderSidebar();
    await vi.waitFor(() => row("idle"));
    await swipe(row("idle"), -100);
    await act(async () =>
      trayOf("idle")!.querySelector<HTMLButtonElement>('button[aria-label="Pin thread"]')!.click(),
    );
    await vi.waitFor(() => expect(state.pinThread).toHaveBeenCalledTimes(1));
  });

  it("archives straight away on a long swipe", async () => {
    await renderSidebar();
    await vi.waitFor(() => row("idle"));
    await swipe(row("idle"), -300);
    await vi.waitFor(() => expect(state.archiveThread).toHaveBeenCalledTimes(1));
    expect(trayOf("idle")).toBeNull();
  });

  it("closes an open row on tap instead of opening the thread", async () => {
    const router = await renderSidebar();
    await vi.waitFor(() => row("idle"));
    await swipe(row("idle"), -100);
    expect(trayOf("idle")).not.toBeNull();
    await swipe(row("idle"), 0);
    expect(trayOf("idle")).toBeNull();
    expect(router.state.location.pathname).toBe("/env-1/pm-thread");
    expect(state.archiveThread).not.toHaveBeenCalled();
  });

  it("leaves vertical scrolling alone", async () => {
    await renderSidebar();
    await vi.waitFor(() => row("idle"));
    await swipe(row("idle"), -20, 120);
    expect(trayOf("idle")).toBeNull();
  });

  it("offers no Archive on a running thread", async () => {
    await renderSidebar();
    await vi.waitFor(() => row("busy"));
    await swipe(row("busy"), -300);
    const labels = [...(trayOf("busy")?.querySelectorAll("button") ?? [])].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Pin"]);
    expect(state.archiveThread).not.toHaveBeenCalled();
  });
});

describe("desktop width", () => {
  it("does not swipe", async () => {
    await page.viewport(1280, 800);
    await renderSidebar();
    await vi.waitFor(() => row("idle"));
    await swipe(row("idle"), -300);
    expect(trayOf("idle")).toBeNull();
    expect(state.archiveThread).not.toHaveBeenCalled();
  });
});
