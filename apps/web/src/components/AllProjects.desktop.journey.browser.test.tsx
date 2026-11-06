import "~/index.css";

import type { ProjectTaskReference, ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

// The desktop app: page headers are the window's drag area.
vi.mock(import("../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => []) as never,
  useProjects: (() => [
    {
      id: "busyboy",
      environmentId: "env-1",
      title: "busyboy",
      workspaceRoot: "/repo/busyboy",
      createdAt: "2026-11-05T09:00:00.000Z",
      updatedAt: "2026-11-05T09:00:00.000Z",
    },
  ]) as never,
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

import { makeProjectManagerSummaryFixture } from "../test-fixtures";
import { AllProjectsPage, SHOW_DONE_TASKS_STORAGE_KEY } from "./allProjects/AllProjectsPage";
import { SidebarProvider } from "./ui/sidebar";

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
    title,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    updatedAt: "2026-11-05T09:00:00.000Z",
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let showDoneWrites: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(SHOW_DONE_TASKS_STORAGE_KEY);
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        taskKeyPrefix: "BB",
        tasks: [
          task("task-1", 1, "Shipped work", { stage: "done" }),
          task("task-2", 2, "Dropped idea", { stage: "cancelled" }),
          task("task-3", 3, "Current work"),
        ],
      }),
    },
  ];
  // Record each write of the setting, so a double flip on one click shows up.
  showDoneWrites = [];
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === SHOW_DONE_TASKS_STORAGE_KEY) showDoneWrites.push(value);
    setItem.call(this, key, value);
  });
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
    ]),
    history: createMemoryHistory({ initialEntries: ["/all-projects"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  await vi.waitFor(() => expect(row("task-3")).not.toBeNull());
}

const row = (id: string) =>
  container.querySelector<HTMLElement>(`[data-all-projects-task="${id}"]`);
const showDoneSwitch = () =>
  page.getByRole("switch", { name: /Show done/ }).element() as HTMLElement;
const showDoneText = () =>
  [...container.querySelectorAll<HTMLElement>("label")].find((label) =>
    label.textContent?.startsWith("Show done"),
  )!;

/**
 * The desktop app drags the window from title bars. A click reaches the page
 * only when the element's nearest ancestor with an app region opts out.
 */
function appRegionAt(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const region = getComputedStyle(node).getPropertyValue("-webkit-app-region");
    if (region !== "" && region !== "none") return region;
  }
  return "none";
}

async function toggleShowsAndHidesDoneTasks() {
  await openAllProjects();
  expect(row("task-1")).toBeNull();
  expect(row("task-2")).toBeNull();
  expect(showDoneText().textContent).toBe("Show done (2)");

  // The header drags the window; the switch and its text opt out, so clicks land.
  expect(appRegionAt(showDoneSwitch().closest("header")!)).toBe("drag");
  expect(appRegionAt(showDoneSwitch())).toBe("no-drag");
  expect(appRegionAt(showDoneText())).toBe("no-drag");

  // One click on the switch is one flip: Done and cancelled tasks appear.
  await userEvent.click(showDoneSwitch());
  await vi.waitFor(() => expect(row("task-1")).not.toBeNull());
  expect(row("task-2")).not.toBeNull();
  expect(showDoneSwitch().getAttribute("aria-checked")).toBe("true");
  expect(showDoneWrites).toEqual(["true"]);

  // Clicking the text flips it back.
  await userEvent.click(showDoneText());
  await vi.waitFor(() => expect(row("task-1")).toBeNull());
  expect(row("task-2")).toBeNull();
  expect(showDoneSwitch().getAttribute("aria-checked")).toBe("false");
  expect(showDoneWrites).toEqual(["true", "false"]);

  // The choice is remembered on the next visit.
  await userEvent.click(showDoneSwitch());
  await vi.waitFor(() => expect(row("task-1")).not.toBeNull());
  await act(() => root.unmount());
  root = createRoot(container);
  await openAllProjects();
  expect(row("task-1")).not.toBeNull();
  expect(showDoneSwitch().getAttribute("aria-checked")).toBe("true");
}

describe("All projects in the desktop app", () => {
  it("shows and hides Done tasks with one click, and remembers it", async () => {
    await page.viewport(1280, 800);
    await toggleShowsAndHidesDoneTasks();
  });

  it("does the same in a narrow window", async () => {
    await page.viewport(390, 844);
    await toggleShowsAndHidesDoneTasks();
  });
});
