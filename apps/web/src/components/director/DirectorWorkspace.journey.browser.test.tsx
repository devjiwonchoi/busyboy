import "~/index.css";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-09T12:00" }));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => []) as never,
  useThreadShell: (() => null) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => state.managers) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";

import { Route as AllProjectsRoute } from "../../routes/_chat.all-projects";
import { goalMapFixture } from "../goalMap/goalMap.test-fixtures";
import { DirectorWorkspaceToggle } from "./DirectorWorkspaceToggle";

function ChatRoute() {
  const { threadId } = useParams({ strict: false });
  return (
    <div data-testid="chat">
      <header>{threadId === "director-thread" ? <DirectorWorkspaceToggle /> : null}</header>
      대화 {threadId}
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.managers = goalMapFixture();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

async function open(initial: string) {
  const base = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: base.addChildren([
      createRoute({ getParentRoute: () => base, path: "/", component: () => <div>홈</div> }),
      createRoute({
        getParentRoute: () => base,
        path: "/all-projects",
        component: AllProjectsRoute.options.component!,
      }),
      createRoute({
        getParentRoute: () => base,
        path: "/$environmentId/$threadId",
        component: ChatRoute,
      }),
    ]),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

for (const [device, width, height] of [
  ["desktop", 1280, 800],
  ["phone", 390, 844],
] as const) {
  it(`opens All projects from the Director chat header on ${device}`, async () => {
    await page.viewport(width, height);
    const router = await open("/env-1/director-thread");
    await vi.waitFor(() => expect(container.textContent).toContain("대화 director-thread"));
    await userEvent.click(page.getByRole("button", { name: "전체 프로젝트", exact: true }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/all-projects"), {
      timeout: 3000,
    });
    await vi.waitFor(() => expect(container.querySelector("[data-goal-map]")).not.toBeNull(), {
      timeout: 3000,
    });
    // It is a page now, not a right panel surface.
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
  });
}

it("waits for the Director before drawing the map", async () => {
  state.managers = goalMapFixture().filter((entry) => entry.summary.kind !== "director");
  await open("/all-projects");
  await vi.waitFor(() => expect(container.textContent).toContain("디렉터를 찾는 중이에요"));
  expect(container.querySelector("[data-goal-map]")).toBeNull();
});
