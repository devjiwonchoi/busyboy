import "~/index.css";

import type { ProjectTeamTaskDetail, ProjectTeamUpdateTaskSpecInput } from "@t3tools/contracts";
import { emptyProjectTaskSpec, newProjectTaskTodo } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const AT = "2026-11-07T09:00:00.000Z";

const state = vi.hoisted(() => ({
  detail: null as unknown as ProjectTeamTaskDetail,
  listeners: new Set<() => void>(),
  updates: [] as ProjectTeamUpdateTaskSpecInput[],
  leadShellExists: true,
  managers: [] as unknown[],
}));

vi.mock(import("../../state/projectTeam"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...(await original()),
    useTaskDetail: (() => {
      const detail = useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.detail,
      );
      return { data: detail, error: null } as never;
    }) as never,
    useProjectManager: (() => ({
      pmThreadId: "pm-thread",
      persona: { name: "Jota" },
      settings: {},
    })) as never,
    useProjectManagerEntries: (() => state.managers) as never,
    useLeadThreadTask: ((ref: { threadId: string } | null) =>
      ref?.threadId === "lead-1" ? { task: state.detail.task } : null) as never,
    useUpdateTaskSpec: (() => (_env: string, input: ProjectTeamUpdateTaskSpecInput) => {
      state.updates.push(input);
      state.detail = {
        ...state.detail,
        versions: [
          ...state.detail.versions,
          { ...state.detail.versions.at(-1)!, version: input.baseVersion + 1, spec: input.spec },
        ],
      };
      for (const listener of state.listeners) listener();
      return Promise.resolve(AsyncResult.success(undefined) as never);
    }) as never,
  };
});

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));

// The thread view here has no router; a plain link stands in for task links.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ params, to: _to, ...rest }: { params?: { taskId?: string }; to?: string }) => (
    <a href={`#${params?.taskId ?? ""}`} {...rest} />
  )) as never,
}));

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: [] }) as never,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: ((ref: { threadId: string } | null) =>
    ref?.threadId === "lead-1" && state.leadShellExists
      ? {
          id: "lead-1",
          projectId: "project-1",
          deletedAt: null,
          runtime: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
        }
      : null) as never,
}));

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useLeadThreadTask } from "~/state/projectTeam";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";
import { TaskPage } from "./TaskPage";
import { TaskPlanSurface, TaskPlanToggle, useOpenTaskPlanOnEntry } from "./TaskPlanSurface";

let container: HTMLDivElement;
let root: Root;

const LEAD = { environmentId: "env-1", threadId: "lead-1" } as unknown as ScopedThreadRef;
const OTHER = { environmentId: "env-1", threadId: "other" } as unknown as ScopedThreadRef;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  state.updates = [];
  state.leadShellExists = true;
  state.managers = [];
  state.detail = {
    key: "BU-49",
    task: {
      id: "task-49",
      projectId: "project-1",
      number: 49,
      title: "Plan in the right sidebar",
      request: "",
      stage: "running",
      waitsOn: [],
      parentTaskId: null,
      leadThreadId: "lead-1",
      prUrl: null,
      planSummary: null,
      resultSummary: null,
      lastOutcome: null,
      nudgeCount: 0,
      iterateRound: 0,
      shipRound: 0,
      roleModels: {},
      modelSteps: {},
      review: null,
      ready: null,
      stageChangedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    versions: [
      {
        taskId: "task-49",
        version: 1,
        spec: {
          ...emptyProjectTaskSpec(),
          background: "Plan was on the left.",
          goal: "The plan is a tab in the right sidebar.",
          successCriteria: "Plan, Browser and back.",
          nonGoals: "",
          todos: [newProjectTaskTodo("t1", "Move the plan")],
        },
        author: "agent",
        authorThreadId: "lead-1",
        note: "Plan",
        createdAt: AT,
      },
    ],
    sessions: [{ taskId: "task-49", threadId: "lead-1", role: "lead", createdAt: AT }],
    children: [],
    openAttention: [],
  } as unknown as ProjectTeamTaskDetail;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

const noop = () => undefined;

/**
 * A thread view wired like ChatView: a stand-in chat whose header has the Plan button, and the
 * real right panel (inline on desktop, a sheet on phones) on the real panel store.
 */
function ThreadView(props: { threadRef: ScopedThreadRef }) {
  const ref = props.threadRef;
  const leadTask = useLeadThreadTask(ref, "project-1" as never);
  useOpenTaskPlanOnEntry(ref, leadTask !== null);
  const panel = useRightPanelStore((store) => selectThreadRightPanelState(store.byThreadKey, ref));
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const active = panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const store = useRightPanelStore.getState;
  const tabs = (
    <RightPanelTabs
      mode={sheet ? "sheet" : "inline"}
      open={panel.isOpen}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={panel.surfaces}
      environmentId={null}
      activeSurfaceId={active?.id ?? null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={(surface) => store().activateSurface(ref, surface.id)}
      onCloseSurface={(surface) => store().closeSurface(ref, surface.id)}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={() => store().openBrowser(ref, null)}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddSideChat={noop}
      onAddTaskPlan={leadTask === null ? undefined : () => store().open(ref, "task-plan")}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      sideChatAvailable={false}
    >
      {active?.kind === "task-plan" ? <TaskPlanSurface threadRef={ref} /> : null}
      {active?.kind === "preview" ? <div data-testid="browser-body">browser</div> : null}
    </RightPanelTabs>
  );
  return (
    <div style={{ display: "flex", height: "100vh", width: "100%" }}>
      <div data-testid="chat" style={{ flex: 1, minWidth: 0 }}>
        <header>{leadTask === null ? null : <TaskPlanToggle threadRef={ref} />}</header>
        chat {ref.threadId}
      </div>
      {sheet ? (
        <RightPanelSheet
          animationDurationMs={0}
          open={panel.isOpen}
          onClose={() => store().close(ref)}
        >
          {tabs}
        </RightPanelSheet>
      ) : panel.isOpen ? (
        tabs
      ) : null}
    </div>
  );
}

const renderThread = (threadRef: ScopedThreadRef) =>
  act(async () => root.render(<ThreadView threadRef={threadRef} />));

const chat = () => container.querySelector<HTMLElement>('[data-testid="chat"]')!;
const planBody = () => document.querySelector<HTMLElement>('[data-testid="task-plan-surface"]');
const browserBody = () => document.querySelector<HTMLElement>('[data-testid="browser-body"]');
const showPlan = () => container.querySelector<HTMLElement>('[aria-label="Show plan"]');
const tab = (title: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-active-tab]")].find(
    (element) => element.textContent === title,
  ) ?? null;

async function addFromMenu(label: string) {
  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Add panel surface"]')!);
  const item = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
      element.textContent?.startsWith(label),
    );
    if (!found) throw new Error(`no ${label} item`);
    return found;
  });
  await userEvent.click(item);
}

async function switchToBrowserAndBack() {
  await addFromMenu("Browser");
  await vi.waitFor(() => expect(browserBody()).not.toBeNull());
  expect(planBody()).toBeNull();
  expect(tab("Plan")?.dataset.activeTab).toBe("false");

  await userEvent.click(tab("Plan")!.querySelector("button:last-of-type")!);
  await vi.waitFor(() => expect(planBody()?.textContent).toContain("The plan is a tab"));
  expect(browserBody()).toBeNull();
}

function taskRef(id: string, number: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    number,
    parentTaskId: null,
    waitsOn: [],
    title,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    updatedAt: AT,
    ...extra,
  };
}

/** BU-49 is part of BU-53, waits on BU-55, blocks BU-60 and has two subtasks, one done. */
function seedStructure() {
  state.managers = [
    {
      environmentId: "env-1",
      summary: {
        projectId: "project-1",
        taskKeyPrefix: "BU",
        tasks: [
          taskRef("task-53", 53, "Director"),
          taskRef("task-55", 55, "Dependency model"),
          taskRef("task-49", 49, "Plan in the right sidebar", {
            leadThreadId: "lead-1",
            parentTaskId: "task-53",
            waitsOn: ["task-55"],
          }),
          taskRef("task-50", 50, "Tab chrome", { stage: "done", parentTaskId: "task-49" }),
          taskRef("task-51", 51, "Phone sheet", { stage: "inbox", parentTaskId: "task-49" }),
          taskRef("task-60", 60, "Release notes", { stage: "inbox", waitsOn: ["task-49"] }),
        ],
      },
    },
  ];
}

/** The Plan tab shows the parent breadcrumb, the markers and the relation lists. */
function expectStructure() {
  const plan = planBody()!;
  const parent = plan.querySelector<HTMLElement>("[data-task-parent]")!;
  expect(parent.textContent).toBe("Director · 프로젝트");
  expect(parent.getAttribute("href")).toBe("#task-53");
  expect(plan.querySelector("[data-subtask-progress]")?.getAttribute("data-subtask-progress")).toBe(
    "1/2",
  );
  const waiting = plan.querySelector<HTMLElement>("[data-waiting-marker]")!;
  expect(waiting.querySelector(".sr-only")?.textContent).toBe(
    "Dependency model · 프로젝트 끝나야 시작",
  );
  expect(waiting.querySelector("[data-waiting-keys]")?.textContent).toBe(
    "Dependency model · 프로젝트",
  );
  expect(plan.querySelector(".lucide-flag")).toBeNull();
  expect(
    plan.querySelector("[data-relation-group='blocked-by'] h3 .lucide-hourglass"),
  ).not.toBeNull();
  // The old "Parent task" / "Subtasks N" chips are gone.
  expect(plan.textContent).not.toContain("Parent task");
  const structure = plan.querySelector<HTMLElement>("[data-task-structure]")!;
  expect(
    [...structure.querySelectorAll("[data-related-task]")].map((row) =>
      row.getAttribute("data-related-task"),
    ),
  ).toEqual(["BU-50", "BU-51", "BU-55", "BU-60"]);
  // "Blocking" has its own chain icon, apart from the waiting hourglass.
  expect(
    structure.querySelector("[data-relation-group='blocking'] h3 .lucide-link-2"),
  ).not.toBeNull();
  for (const row of structure.querySelectorAll<HTMLElement>("[data-related-task]")) {
    expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
      plan.getBoundingClientRect().right + 1,
    );
  }
}

describe("task lead thread on desktop", () => {
  it("shows the task's parent, blockers and subtasks on the Plan tab", async () => {
    await page.viewport(1280, 800);
    seedStructure();
    await renderThread(LEAD);
    await vi.waitFor(() =>
      expect(planBody()?.querySelector("[data-task-structure]")).not.toBeNull(),
    );
    expectStructure();
  });

  it("opens on the Plan tab in the right panel, switches to Browser and back", async () => {
    await page.viewport(1280, 800);
    await renderThread(LEAD);

    // Entering the task opens the right panel on Plan, to the right of the chat.
    await vi.waitFor(() =>
      expect(planBody()?.textContent).toContain("The plan is a tab in the right sidebar."),
    );
    expect(planBody()!.textContent).toContain("Plan, Browser and back.");
    expect(tab("Plan")?.dataset.activeTab).toBe("true");
    expect(planBody()!.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      chat().getBoundingClientRect().right - 1,
    );
    expect(showPlan()).toBeNull();

    // Checking a todo still saves a new spec version.
    await userEvent.click(planBody()!.querySelector('[aria-label="Move the plan"]')!);
    await vi.waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0]?.spec.todos[0]?.done).toBe(true);

    await switchToBrowserAndBack();

    // On another tab the header offers the plan back.
    await userEvent.click(tab("Browser")!.querySelector("button:last-of-type")!);
    await vi.waitFor(() => expect(browserBody()).not.toBeNull());
    await userEvent.click(showPlan()!);
    await vi.waitFor(() => expect(planBody()).not.toBeNull());

    // Leaving on Browser and coming back lands on the plan again.
    await userEvent.click(tab("Browser")!.querySelector("button:last-of-type")!);
    await renderThread(OTHER);
    await renderThread(LEAD);
    await vi.waitFor(() => expect(tab("Plan")?.dataset.activeTab).toBe("true"));
    expect(planBody()).not.toBeNull();
  });

  it("offers no plan on a thread that leads no task", async () => {
    await page.viewport(1280, 800);
    useRightPanelStore.getState().openBrowser(OTHER, null);
    await renderThread(OTHER);
    expect(tab("Plan")).toBeNull();
    expect(showPlan()).toBeNull();
    await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Add panel surface"]')!);
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
    expect(labels.some((label) => label?.startsWith("Plan"))).toBe(false);
  });
});

describe("task lead thread on a phone", () => {
  it("shows the task's parent, blockers and subtasks on the Plan tab", async () => {
    await page.viewport(390, 844);
    seedStructure();
    await renderThread(LEAD);
    await vi.waitFor(() =>
      expect(planBody()?.querySelector("[data-task-structure]")).not.toBeNull(),
    );
    expectStructure();
  });

  it("opens the panel sheet on Plan, switches to Browser and back, and reopens from the header", async () => {
    await page.viewport(390, 844);
    await renderThread(LEAD);

    await vi.waitFor(() =>
      expect(planBody()?.textContent).toContain("The plan is a tab in the right sidebar."),
    );
    expect(tab("Plan")?.dataset.activeTab).toBe("true");
    await userEvent.click(planBody()!.querySelector('[aria-label="Move the plan"]')!);
    await vi.waitFor(() => expect(state.updates).toHaveLength(1));

    await switchToBrowserAndBack();

    // Closing the sheet shows the chat; the header's Plan button opens the sheet on Plan.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(showPlan()).not.toBeNull());
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LEAD).isOpen,
    ).toBe(false);
    expect(chat().getBoundingClientRect().width).toBeGreaterThan(380);
    await userEvent.click(showPlan()!);
    await vi.waitFor(() => expect(showPlan()).toBeNull());
    expect(tab("Plan")?.dataset.activeTab).toBe("true");
    expect(planBody()?.textContent).toContain("The plan is a tab in the right sidebar.");
  });
});

describe("opening a task", () => {
  function renderTaskRoute() {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const taskRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks/$environmentId/$projectId/$taskId",
      component: () => (
        <TaskPage
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          taskId={"task-49" as never}
        />
      ),
    });
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$environmentId/$threadId",
      component: () => <div data-testid="thread-route">thread</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([taskRoute, threadRoute]),
      history: createMemoryHistory({ initialEntries: ["/tasks/env-1/project-1/task-49"] }),
    });
    return {
      router,
      render: () => act(async () => root.render(<RouterProvider router={router} />)),
    };
  }

  it("lands on the lead's chat", async () => {
    const app = renderTaskRoute();
    await app.render();
    await vi.waitFor(() => expect(app.router.state.location.pathname).toBe("/env-1/lead-1"));
    expect(container.querySelector('[data-testid="thread-route"]')).not.toBeNull();
  });

  it("shows only the plan for a task with no lead session", async () => {
    state.leadShellExists = false;
    state.detail = {
      ...state.detail,
      task: { ...state.detail.task, leadThreadId: null, stage: "inbox" },
      sessions: [],
    };
    const app = renderTaskRoute();
    await app.render();
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="task-page"]')?.textContent).toContain(
        "Saved without an agent.",
      ),
    );
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/project-1/task-49");
  });
});
