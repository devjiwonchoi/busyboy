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
  useProjects: (() =>
    ["busyboy", "site", "docs"].map((id) => ({
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

import { makeProjectManagerSummaryFixture } from "../test-fixtures";
import { AllProjectsPage } from "./allProjects/AllProjectsPage";
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
    waitsOn: [],
    title,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: new Date().toISOString(),
    checks: [{ text: "check", passed: false }],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

function manager(projectId: string, tasks: ProjectTaskReference[]) {
  return {
    environmentId: "env-1",
    summary: makeProjectManagerSummaryFixture({
      projectId: projectId as never,
      pmThreadId: `pm-${projectId}` as never,
      taskKeyPrefix: projectId.slice(0, 2).toUpperCase(),
      tasks,
      ...(projectId === "busyboy"
        ? {
            decisionCards: [
              {
                taskNumber: 1,
                taskTitle: "Map",
                plan: null,
                proposal: null,
                item: {
                  id: "card-1" as never,
                  projectId: "busyboy" as never,
                  taskId: "bb-1" as never,
                  kind: "approval" as const,
                  question: "?",
                  options: [],
                  answer: null,
                  answeredAt: null,
                  askerThreadId: null,
                  batchId: "batch" as never,
                  createdAt: "2026-11-05T09:00:00.000Z",
                  supersededAt: null,
                  answeredBy: null,
                  specVersion: null,
                  summary: null,
                  verification: null,
                },
              },
            ],
          }
        : {}),
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.managers = [
    manager("busyboy", [task("bb-1", 1, "Project map")]),
    manager("site", [task("si-1", 1, "Launch page", { waitsOn: ["bb-1" as never] })]),
    manager("docs", [task("do-1", 1, "Guides", { stage: "inbox" })]),
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

const card = (projectId: string) =>
  container.querySelector<HTMLElement>(`[data-project-card="${projectId}"]`)!;
const arrow = () => container.querySelector<SVGPathElement>("[data-map-arrow]")!;

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

describe("All projects in the desktop app", () => {
  it("keeps the header's buttons clickable and highlights one card's arrows on hover", async () => {
    await page.viewport(1280, 800);
    const router = await openAllProjects();

    // The header drags the window; the "나를 기다림" pill opts out, so clicks land.
    const pill = container.querySelector<HTMLElement>("[data-needs-you-total]")!;
    expect(pill.textContent).toBe("나를 기다림 1");
    expect(appRegionAt(pill.closest("header")!)).toBe("drag");
    expect(appRegionAt(pill)).toBe("no-drag");

    // site waits on busyboy: one dashed arrow between their goals.
    await vi.waitFor(() => expect(arrow()).not.toBeNull());
    expect(arrow().getAttribute("data-from")).toBe("si-1");
    expect(arrow().getAttribute("data-to")).toBe("bb-1");
    expect(arrow().getAttribute("d")).toMatch(/^M[\d.-]+,[\d.-]+ C/);

    // Hovering a card keeps its arrows strong and fades the rest.
    await userEvent.hover(card("docs"));
    await vi.waitFor(() => expect(arrow().getAttribute("opacity")).toBe("0.25"));
    await userEvent.hover(card("site"));
    await vi.waitFor(() => expect(arrow().getAttribute("opacity")).toBe("1"));
    expect(card("docs").className).toContain("opacity-60");
    expect(card("busyboy").className).not.toContain("opacity-60");

    const scroll = vi.spyOn(
      container.querySelector<HTMLElement>("[data-director-inbox]")!,
      "scrollIntoView",
    );
    await userEvent.click(pill);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(router.state.location.pathname).toBe("/all-projects");
  });
});
