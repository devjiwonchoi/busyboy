import "~/index.css";

import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

// The desktop app: page headers are the window's drag area.
vi.mock(import("../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-09T12:00" }));
vi.mock(import("../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => []) as never,
  useProjects: (() =>
    ["a", "b"].map((id) => ({
      id,
      environmentId: "env-1",
      title: id,
      workspaceRoot: `/repo/${id}`,
      createdAt: "2026-11-05T09:00:00.000Z",
      updatedAt: "2026-11-05T09:00:00.000Z",
    }))) as never,
}));
vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => state.managers) as never,
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

import { goalGraphFixture, graphTask } from "./goalGraph/goalGraph.test-fixtures";
vi.mock(import("./director/useDirectorChat"), () => ({ useDirectorChat: () => null }));

import { AllProjectsPage } from "./allProjects/AllProjectsPage";
import { SidebarProvider } from "./ui/sidebar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.managers = goalGraphFixture();
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

async function openAllProjects() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <div style={{ display: "flex", width: "100%" }}>
          <Outlet />
        </div>
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/all-projects",
        component: AllProjectsPage,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/tasks/$environmentId/$projectId/$taskId",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/$environmentId/$threadId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/all-projects"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  await vi.waitFor(() => expect(container.querySelector("[data-project-card]")).not.toBeNull());
  return router;
}

const taskNode = (id: string) => container.querySelector<HTMLElement>(`[data-task-node="${id}"]`)!;
const goalNode = (id: string) => container.querySelector<HTMLElement>(`[data-goal-node="${id}"]`)!;
async function openGraph() {
  const router = await openAllProjects();
  await userEvent.click(page.getByRole("button", { name: "목표 그래프", exact: true }));
  await vi.waitFor(() => expect(goalNode("goal-1") === null).toBe(false));
  return router;
}

describe("goal graph journey", () => {
  it("shows desktop dependencies, dims unrelated work, zooms and opens a task", async () => {
    await page.viewport(1280, 800);
    const router = await openGraph();
    expect(container.querySelectorAll("[data-project-node]").length).toBe(2);
    expect(container.querySelectorAll('[data-edge="goal-project"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-edge="project-task"]').length).toBeGreaterThan(0);
    expect(
      container.querySelector(
        '[data-edge="waits"][data-from="task:env-1/b-1"][data-to="task:env-1/a-2"][data-blocked="true"]',
      ) === null,
    ).toBe(false);
    expect(container.textContent).toContain("목표 없음");
    expect(container.textContent).toContain("빠진 일 있음");
    expect(container.textContent).toContain("디렉터 제안 1");
    await userEvent.hover(taskNode("b-1"));
    await vi.waitFor(() => expect(goalNode("goal-3").parentElement!.style.opacity).toBe("0.25"));
    for (let count = 0; count < 3; count++) {
      await userEvent.click(page.getByRole("button", { name: "축소", exact: true }));
    }
    expect(container.querySelector('[data-zoom="far"]') === null).toBe(false);
    expect(container.querySelectorAll("[data-task-node]").length).toBe(0);
    expect(container.querySelectorAll("[data-progress-ring]").length).toBe(6);
    await userEvent.click(page.getByRole("button", { name: "목표 2 0/1", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "막힌 곳 2", exact: true }));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-zoom="near"]') === null).toBe(false),
    );
    // "맞춤" brings the whole graph back into view with tasks still shown.
    await userEvent.click(page.getByRole("button", { name: "맞춤", exact: true }));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-zoom="near"]') === null).toBe(false),
    );
    await page.screenshot({ path: "__screenshots__/goal-graph-desktop.png" });
    await userEvent.click(taskNode("a-1"));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/tasks/env-1/a/a-1"));
  });
  it("opens the whole graph in view and a project's PM chat on click", async () => {
    await page.viewport(1280, 800);
    const router = await openGraph();
    const canvas = container.querySelector<HTMLElement>("[data-zoom]")!.getBoundingClientRect();
    const goal = goalNode("goal-1").getBoundingClientRect();
    expect(goal.left).toBeGreaterThanOrEqual(canvas.left);
    expect(container.querySelector('[data-zoom="near"]') === null).toBe(false);
    await userEvent.click(container.querySelector<HTMLElement>('[data-project-node="env-1/b"]')!);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/pm-b"));
  });
  it("opens a tall graph zoomed in enough to show its tasks", async () => {
    await page.viewport(1280, 800);
    const a = state.managers[0]!;
    a.summary = {
      ...a.summary,
      tasks: [
        ...a.summary.tasks,
        ...Array.from({ length: 15 }, (_, index) =>
          graphTask(`a-extra-${index}`, 20 + index, undefined),
        ),
      ],
    };
    await openGraph();
    expect(container.querySelector('[data-zoom="near"]') === null).toBe(false);
    expect(taskNode("a-extra-0") === null).toBe(false);
  });
  it("opens the mobile tree, shows blocked dependencies and opens the waiting card", async () => {
    await page.viewport(390, 844);
    const router = await openGraph();
    expect(container.querySelector("[data-goal-tree]") === null).toBe(false);
    expect(goalNode("goal-2").getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(goalNode("goal-2"));
    expect(goalNode("goal-2").getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(goalNode("goal-2"));
    // A subtask sits right under its parent.
    const order = [...container.querySelectorAll<HTMLElement>("[data-task-node]")].map(
      (node) => node.dataset.taskNode,
    );
    expect(order.indexOf("a-3")).toBe(order.indexOf("a-1") + 1);
    expect(container.textContent).toContain("⏳ A-2 막힘");
    expect(taskNode("b-1").getAttribute("data-tone")).toBe("blocked");
    expect(taskNode("b-1").parentElement!.className).toContain("border-l-red-500");
    expect(container.textContent).toContain("목표 없음");
    expect(container.textContent).toContain("빠진 일 있음");
    await page.screenshot({ path: "__screenshots__/goal-graph-mobile.png" });
    const badge = taskNode("a-1").parentElement!.querySelectorAll("button")[1]!;
    await userEvent.click(badge);
    // "나를 기다림" opens the waiting card itself, right here.
    await vi.waitFor(() =>
      expect(
        document.querySelector('[role="dialog"] [data-decision-card="card-a-1"]') === null,
      ).toBe(false),
    );
    expect(router.state.location.pathname).toBe("/all-projects");
  });
});
