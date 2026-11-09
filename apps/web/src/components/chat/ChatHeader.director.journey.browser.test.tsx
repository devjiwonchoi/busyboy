import "~/index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";

const director = vi.hoisted(() => ({ summary: null as unknown }));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: (() => director.summary) as never,
  useLeadThreadTask: (() => null) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: (() => null) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));

import { ChatHeader } from "./ChatHeader";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  director.summary = makeProjectManagerSummaryFixture({
    projectId: "director" as never,
    pmThreadId: "director-thread" as never,
    kind: "director",
    persona: { name: "Director", avatar: { kind: "emoji", emoji: "🧭" }, voice: "chill" },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps the Director's name readable in a phone-width chat header", async () => {
  await page.viewport(390, 844);
  // The chat header row: sidebar toggle on the left, panel toggles on the right.
  await act(() =>
    root.render(
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: 390, padding: 12 }}>
        <span style={{ width: 28, flexShrink: 0 }} />
        <ChatHeader
          activeThreadEnvironmentId={"env-1" as never}
          activeThreadId={"director-thread" as never}
          activeThreadTitle="Director"
          isServerThread
          activeProject={
            {
              environmentId: "env-1",
              id: "director",
              title: "Director",
              workspaceRoot: "/base/director",
              repositoryIdentity: null,
            } as never
          }
          parentThreadLink={null}
          onOpenThread={() => {}}
          rightPanelOpen={false}
          onNewThreadInProject={() => {}}
        />
      </div>,
    ),
  );

  const breadcrumb = page.getByRole("navigation", { name: "Thread breadcrumb" }).element();
  // No "Director / Director": the Director's hidden project has no crumb of its own.
  expect(breadcrumb.querySelector('[aria-label^="New thread in"]')).toBeNull();
  const name = [...container.querySelectorAll("h2")].find((node) =>
    node.textContent?.includes("Director"),
  )!;
  expect(name.textContent).toBe("Director");
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  expect(name.getBoundingClientRect().width).toBeGreaterThan(30);
  // The workspace toggle fits as an icon, keeping its label for screen readers.
  expect(page.getByRole("button", { name: "전체 프로젝트", exact: true }).element()).toBeTruthy();
});
