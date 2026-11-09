import "~/index.css";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act, useSyncExternalStore } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const NOW = "2026-11-05T09:00:00.000Z";
const LAST_REPLY = "Two tasks are in review and one needs your answer on the login provider.";

const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  version: 0,
  listeners: new Set<() => void>(),
}));

/** Re-renders whoever reads the managers, like the real attention stream does. */
function useManagers() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.version,
  );
  return state.managers;
}

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
  useProjectManagerEntries: (() => useManagers()) as never,
  useEnvironmentProjectTeamAttention: (() => {
    const managers = useManagers();
    return {
      byProjectId: new Map(managers.map((m) => [m.summary.projectId, m.summary])),
      byPmThreadId: new Map(managers.map((m) => [m.summary.pmThreadId, m.summary])),
    };
  }) as never,
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

function lead(number: number): EnvironmentThreadShell {
  return {
    ...threadShell(`lead-${number}`, "busyboy", `2026-11-05T08:1${number}:00.000Z`),
    title: `Task ${number}`,
    lineage: {
      rootThreadId: "pm-thread",
      parentThreadId: "pm-thread",
      relationshipToParent: "subagent",
    } as never,
  };
}

function manager(patch: Parameters<typeof makeProjectManagerSummaryFixture>[0] = {}) {
  return {
    environmentId: "env-1",
    summary: makeProjectManagerSummaryFixture({
      projectId: "busyboy" as never,
      pmThreadId: "pm-thread" as never,
      openCount: 2,
      lastMessage: { role: "assistant", text: LAST_REPLY, at: NOW },
      tasks: [1, 2].map((number) => ({
        id: `task-${number}` as never,
        number,
        parentTaskId: null,
        waitsOn: [],
        title: `Task ${number}`,
        stage: number === 1 ? "inbox" : "planning",
        leadThreadId: `lead-${number}` as never,
        prUrl: null,
        lastOutcome: null,
        openQuestion: false,
        openBlocker: false,
        iterateRound: 0,
        shipRound: 0,
        modelSteps: {},
        updatedAt: null,
      })),
      ...patch,
    }),
  };
}

function pushManager(next: ReturnType<typeof manager>) {
  state.managers = [next];
  state.version += 1;
  for (const listener of state.listeners) listener();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projects = [project("busyboy", "busyboy")];
  state.groups = [projectGroup("busyboy", "busyboy")];
  state.threads = [
    threadShell("pm-thread", "busyboy", "2026-11-05T08:59:00.000Z"),
    lead(1),
    lead(2),
    threadShell("My own thread", "busyboy", "2026-11-05T08:30:00.000Z"),
  ];
  state.managers = [manager()];
  state.version = 0;
  state.listeners.clear();
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

function renderSidebarApp(initialPath = "/") {
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
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const managerRow = () =>
  container.querySelector<HTMLElement>('[data-testid="sidebar-project-manager-heading"]');
const preview = () =>
  managerRow()?.querySelector<HTMLElement>('[data-testid="sidebar-project-manager-preview"]') ??
  null;
const rowTitles = () =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]')].map(
    (card) => card.querySelector("span.sr-only")?.textContent ?? "",
  );
const rowToggle = () =>
  managerRow()?.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-project-manager-toggle"]',
  ) ?? null;
/** Clicks where the avatar is drawn; the row's one button sits under it. */
async function clickAvatar() {
  const avatar = managerRow()!.querySelector<HTMLElement>('[role="img"][aria-label^="Remy"]')!;
  const toggle = rowToggle()!;
  const a = avatar.getBoundingClientRect();
  const t = toggle.getBoundingClientRect();
  expect(document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2)).toBe(toggle);
  await userEvent.click(toggle, {
    position: { x: a.x - t.x + a.width / 2, y: a.y - t.y + a.height / 2 },
  });
}
/** Vitest's toBeVisible ignores a parent's opacity, so multiply it up the tree. */
function effectiveOpacity(element: Element): number {
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity);
  }
  return opacity;
}
const buttonNamed = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  );

async function expectChatListRow() {
  await vi.waitFor(() => expect(preview()?.textContent).toBe(LAST_REPLY));
  const row = managerRow()!;
  // Two lines: a tall row with a big avatar, like a chat list.
  expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  const avatar = row.querySelector<HTMLElement>('[role="img"][aria-label^="Remy"]')!;
  expect(avatar.getBoundingClientRect().width).toBeGreaterThanOrEqual(32);
  expect(row.textContent).toContain("Remy");
  expect(row.textContent).toContain("busyboy");
  expect(row.querySelector('[aria-label="Needs you: 2"]')?.textContent).toBe("2");
  // The preview is one truncated line with real room, not squeezed out by the buttons.
  const line = preview()!.getBoundingClientRect();
  expect(line.width).toBeGreaterThan(120);
  expect(line.height).toBeLessThan(24);
  expect(preview()!.scrollWidth).toBeGreaterThan(preview()!.clientWidth);
  expect(buttonNamed("Sitrep")?.getBoundingClientRect().width).toBeGreaterThan(0);
}

describe("sidebar manager row", () => {
  it("shows the manager like a chat list row", async () => {
    await renderSidebarApp().render();
    await expectChatListRow();
    // Its sessions show once its chat is open.
    expect(rowTitles()).not.toContain("Task 1");
    await act(() => root.unmount());
    root = createRoot(container);
    await renderSidebarApp("/env-1/pm-thread").render();
    await vi.waitFor(() =>
      expect(rowTitles()).toEqual(expect.arrayContaining(["Task 1", "Task 2", "My own thread"])),
    );
  });

  it("works the same at phone width", async () => {
    await page.viewport(390, 844);
    await renderSidebarApp().render();
    await expectChatListRow();
  });

  for (const [label, width, height] of [
    ["desktop", 1280, 800],
    ["phone", 390, 844],
  ] as const) {
    it(`opens the PM chat from anywhere on the row, then folds and unfolds it (${label})`, async () => {
      await page.viewport(width, height);
      const app = renderSidebarApp();
      await app.render();
      await vi.waitFor(() => expect(preview()?.textContent).toBe(LAST_REPLY));
      const toggle = rowToggle()!;

      // Coming from another session, the avatar opens the PM chat and keeps the list open.
      await clickAvatar();
      await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-thread"));
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-current")).toBe("page");
      expect(rowTitles()).toEqual(expect.arrayContaining(["Task 1", "My own thread"]));

      // On the PM chat, the avatar and the rest of the row fold and unfold.
      await clickAvatar();
      await vi.waitFor(() => expect(rowTitles()).toEqual([]));
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(toggle);
      await vi.waitFor(() =>
        expect(rowTitles()).toEqual(expect.arrayContaining(["Task 1", "My own thread"])),
      );

      // Fold it, go to another session, then click the row: it opens the PM chat and unfolds.
      await userEvent.click(toggle);
      await vi.waitFor(() => expect(rowTitles()).toEqual([]));
      await act(() => app.router.navigate({ to: "/" }));
      await userEvent.click(toggle);
      await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/pm-thread"));
      await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
      expect(rowTitles()).toEqual(expect.arrayContaining(["Task 1", "My own thread"]));
    });

    it(`keeps one + menu and Sitrep clear of the preview (${label})`, async () => {
      await page.viewport(width, height);
      await renderSidebarApp().render();
      await vi.waitFor(() => expect(preview()?.textContent).toBe(LAST_REPLY));
      const add = buttonNamed("Add to busyboy")!;
      const sitrep = buttonNamed("Sitrep")!;
      if (label === "phone") {
        // Phones cannot hover: both buttons show without it.
        expect(effectiveOpacity(add)).toBe(1);
      } else {
        expect(effectiveOpacity(add)).toBe(0);
        await userEvent.hover(managerRow()!);
        await vi.waitFor(() => expect(effectiveOpacity(add)).toBe(1));
      }
      expect(effectiveOpacity(sitrep)).toBe(1);
      // The old look-alike buttons are gone.
      expect(buttonNamed("New task in busyboy")).toBeUndefined();
      expect(buttonNamed("New thread in busyboy")).toBeUndefined();
      // Neither button covers the preview line.
      const line = preview()!.getBoundingClientRect();
      for (const button of [add, sitrep]) {
        const box = button.getBoundingClientRect();
        expect(box.bottom <= line.top || box.top >= line.bottom).toBe(true);
      }

      await userEvent.click(add);
      const items = await vi.waitFor(() => {
        const found = [...document.querySelectorAll('[data-slot="menu-item"]')].map(
          (item) => item.textContent,
        );
        expect(found.length).toBeGreaterThan(0);
        return found;
      });
      expect(items).toEqual(["New thread"]);
    });
  }

  it("follows the PM chat as new messages arrive", async () => {
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(preview()?.textContent).toBe(LAST_REPLY));

    await act(async () =>
      pushManager(manager({ lastMessage: { role: "user", text: "Ship #2 first", at: NOW } })),
    );
    await vi.waitFor(() => expect(preview()?.textContent).toBe("You: Ship #2 first"));

    await act(async () =>
      pushManager(manager({ lastMessage: { role: "assistant", text: "On it.", at: NOW } })),
    );
    await vi.waitFor(() => expect(preview()?.textContent).toBe("On it."));
  });

  it("says so before the PM chat has any message", async () => {
    state.managers = [manager({ lastMessage: null, openCount: 0 })];
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(preview()?.textContent).toBe("No messages yet"));
    expect(managerRow()!.querySelector('[aria-label^="Needs you"]')).toBeNull();
  });
});
