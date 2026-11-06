import "~/index.css";

import type { ProjectTeamTaskDetail, ProjectTeamUpdateTaskSpecInput } from "@t3tools/contracts";
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
    useProjectManager: (() => ({ pmThreadId: "pm-thread", persona: { name: "Jota" } })) as never,
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

import { useTaskPlanPanelStore } from "~/taskPlanPanelStore";
import { TaskLeadLayout } from "./TaskLeadLayout";
import { TaskPage } from "./TaskPage";
import { TaskPlanToggle } from "./TaskPlanPanel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  useTaskPlanPanelStore.setState({ open: true, width: 360, mobileOpen: false });
  state.updates = [];
  state.leadShellExists = true;
  state.detail = {
    key: "BU-45",
    task: {
      id: "task-45",
      projectId: "project-1",
      number: 45,
      title: "Task page = the lead's session",
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
      stageChangedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    versions: [
      {
        taskId: "task-45",
        version: 1,
        spec: {
          background: "Plan on the left.",
          goal: "The lead's chat with the plan beside it.",
          successCriteria: "Right panel works.",
          nonGoals: "",
          todos: [{ id: "t1", text: "Move the plan", done: false, subtaskId: null }],
        },
        author: "agent",
        authorThreadId: "lead-1",
        note: "Plan",
        createdAt: AT,
      },
    ],
    sessions: [{ taskId: "task-45", threadId: "lead-1", role: "lead", createdAt: AT }],
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
  await page.viewport(1280, 800);
});

/** The lead's thread view: the layout around a stand-in chat whose header has the Plan button. */
function renderLeadThread() {
  return act(async () =>
    root.render(
      <div style={{ display: "flex", height: 800, width: "100%" }}>
        <TaskLeadLayout
          threadRef={{ environmentId: "env-1", threadId: "lead-1" } as never}
          projectId={"project-1" as never}
        >
          <div data-testid="chat">
            <header>
              <TaskPlanToggle />
            </header>
            chat lead-1
          </div>
        </TaskLeadLayout>
      </div>,
    ),
  );
}

const panel = () => container.querySelector<HTMLElement>('[data-testid="task-plan-panel"]');
const chat = () => container.querySelector<HTMLElement>('[data-testid="chat"]')!;
const showPlan = () => container.querySelector<HTMLElement>('[aria-label="Show plan"]');

describe("task lead thread on desktop", () => {
  it("shows the plan left of the chat, saves todos, resizes and remembers being hidden", async () => {
    await page.viewport(1280, 800);
    await renderLeadThread();

    // The plan sits to the left of the chat and shows the spec.
    expect(panel()?.textContent).toContain("The lead's chat with the plan beside it.");
    expect(panel()?.textContent).toContain("Right panel works.");
    expect(panel()!.getBoundingClientRect().right).toBeLessThanOrEqual(
      chat().getBoundingClientRect().left + 1,
    );
    expect(showPlan()).toBeNull();

    // Checking a todo still saves a new spec version.
    await userEvent.click(panel()!.querySelector('[aria-label="Move the plan"]')!);
    await vi.waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0]?.spec.todos[0]?.done).toBe(true);

    // Resize with the keyboard on the handle; the width is remembered.
    const handle = panel()!.querySelector<HTMLElement>('[aria-label="Resize plan"]')!;
    handle.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await vi.waitFor(() => expect(panel()!.getBoundingClientRect().width).toBe(392));
    expect(JSON.parse(localStorage.getItem("busyboy:task-plan-panel:v1")!).state.width).toBe(392);

    // Hide it: the chat takes the room and the header offers the plan back.
    await userEvent.click(panel()!.querySelector('[aria-label="Hide plan"]')!);
    await vi.waitFor(() => expect(panel()).toBeNull());
    expect(JSON.parse(localStorage.getItem("busyboy:task-plan-panel:v1")!).state.open).toBe(false);
    await userEvent.click(showPlan()!);
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    expect(panel()!.getBoundingClientRect().width).toBe(392);
  });

  it("shows no plan for a thread that leads no task", async () => {
    await act(async () =>
      root.render(
        <TaskLeadLayout
          threadRef={{ environmentId: "env-1", threadId: "other" } as never}
          projectId={"project-1" as never}
        >
          <div data-testid="chat">chat other</div>
        </TaskLeadLayout>,
      ),
    );
    expect(panel()).toBeNull();
    expect(chat().textContent).toBe("chat other");
  });
});

describe("task lead thread on a phone", () => {
  it("keeps the chat full width and opens the plan as a sheet from the header", async () => {
    await page.viewport(390, 844);
    await renderLeadThread();
    expect(panel()).toBeNull();
    expect(chat().getBoundingClientRect().width).toBeGreaterThan(380);

    await userEvent.click(showPlan()!);
    const sheet = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="task-plan-sheet"]');
      if (element === null) throw new Error("plan sheet not open");
      return element;
    });
    expect(sheet.textContent).toContain("The lead's chat with the plan beside it.");
    await userEvent.click(sheet.querySelector('[aria-label="Move the plan"]')!);
    await vi.waitFor(() => expect(state.updates).toHaveLength(1));
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
          taskId={"task-45" as never}
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
      history: createMemoryHistory({ initialEntries: ["/tasks/env-1/project-1/task-45"] }),
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
    expect(app.router.state.location.pathname).toBe("/tasks/env-1/project-1/task-45");
  });
});
