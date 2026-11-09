import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAttentionSummary,
  ProjectTaskEventId,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

// The fake server: applies a settings patch the way ProjectTeamService.applySettings does.
const server = vi.hoisted(() => ({
  patches: [] as Array<{ projectId: string; patch: unknown }>,
  apply: (_projectId: string, _patch: { afk: { hours: number | null } | null | undefined }) => {},
  /** The server answering a lead's question for the user after the grace period. */
  answerWhileAfk: () => {},
}));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useUpdateTeamSettings: (() => (ref: { projectId: string }, patch: never) => {
    server.patches.push({ projectId: ref.projectId, patch });
    server.apply(ref.projectId, patch);
    return Promise.resolve();
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("../../state/director"), async (original) => ({
  ...(await original()),
  useDirectorInbox: () => ({ groups: [], total: 0 }),
  useDirectorThreadRef: () => null,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { AfkBanner } from "./Afk";
import { SidebarProvider } from "../ui/sidebar";
import { DecisionCard } from "./DecisionCard";
import { SitrepIntervalPicker, SitrepSettingsContent } from "./SitrepIntervalPicker";

const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);
const LEAD_THREAD_ID = ThreadId.make("lead-thread");
const QUESTION = "Which database should the cache use?";
const ANSWER = "Redis (Recommended)";

function afkAnsweredCard(answeredAt: string): ProjectDecisionCard {
  return {
    taskNumber: 3,
    taskTitle: "Add a cache",
    proposal: null,
    plan: null,
    item: {
      id: ProjectAttentionItemId.make("attention-cache"),
      projectId: ProjectId.make("project-1"),
      taskId: ProjectTaskId.make("task-3"),
      kind: "decision",
      question: QUESTION,
      options: [ANSWER, "Postgres"],
      answer: ANSWER,
      answeredAt,
      askerThreadId: LEAD_THREAD_ID,
      batchId: ProjectAttentionBatchId.make("batch-1"),
      createdAt: answeredAt,
      supersededAt: null,
      answeredBy: "afk",
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  server.patches = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const OTHER_PROJECT = "project-2";

function withAfk(
  summary: ProjectTeamAttentionSummary,
  patch: { hours: number | null } | null,
): ProjectTeamAttentionSummary {
  const { afk: _old, ...settings } = summary.settings;
  if (patch === null) return { ...summary, settings, afkAnswers: [] };
  const since = new Date().toISOString();
  const until =
    patch.hours === null ? null : new Date(Date.now() + patch.hours * 3_600_000).toISOString();
  return { ...summary, settings: { ...settings, afk: { since, until } }, afkAnswers: [] };
}

/**
 * Two PM areas keep independent AFK settings.
 */
function PmChat(props: { compact: boolean; initial: ProjectTeamAttentionSummary | undefined }) {
  const [summary, setSummary] = useState(props.initial ?? makeProjectManagerSummaryFixture());
  const [other, setOther] = useState(() =>
    makeProjectManagerSummaryFixture({
      projectId: ProjectId.make(OTHER_PROJECT),
      pmThreadId: ThreadId.make("pm-thread-2"),
    }),
  );
  server.apply = (projectId, patch) => {
    if (patch.afk === undefined) return;
    const afk = patch.afk;
    (projectId === OTHER_PROJECT ? setOther : setSummary)((current) => withAfk(current, afk));
  };
  server.answerWhileAfk = () => {
    const at = new Date().toISOString();
    setSummary((current) => ({
      ...current,
      decisionCards: [afkAnsweredCard(at)],
      afkAnswers: [
        {
          id: ProjectTaskEventId.make("event-1"),
          at,
          threadId: LEAD_THREAD_ID,
          taskId: ProjectTaskId.make("task-3"),
          text: `${QUESTION} → ${ANSWER}`,
        },
      ],
    }));
  };
  return (
    <SidebarProvider style={{ minHeight: 0, display: "block" }}>
      <div
        style={{ display: "flex", flexDirection: props.compact ? "column" : "row", width: "100%" }}
      >
        {[summary, other].map((entry, index) => {
          const ref = scopeProjectRef(projectRef.environmentId, entry.projectId);
          return (
            <section
              key={entry.projectId}
              aria-label={index === 0 ? "project A" : "project B"}
              style={{ minWidth: 0, flex: 1, padding: 12 }}
            >
              {entry.decisionCards.map((card) => (
                <DecisionCard
                  key={card.item.id}
                  card={card}
                  environmentId={ref.environmentId}
                  threadRef={scopeThreadRef(ref.environmentId, entry.pmThreadId)}
                  cwd={undefined}
                />
              ))}
              <AfkBanner projectRef={ref} summary={entry} />
              <div className="rounded-xl border p-2">
                {props.compact ? (
                  // Phones share this content with the composer's overflow menu.
                  <SitrepSettingsContent projectRef={ref} summary={entry} />
                ) : (
                  <SitrepIntervalPicker projectRef={ref} summary={entry} />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </SidebarProvider>
  );
}

async function renderPmChat(compact: boolean, initial?: ProjectTeamAttentionSummary) {
  const rootRoute = createRootRoute({
    component: () => <PmChat compact={compact} initial={initial} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/$environmentId/$threadId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/env-1/pm-thread"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

const project = (name: "A" | "B") => page.getByRole("region", { name: `project ${name}` });
const banner = () => project("A").getByRole("status", { name: "AFK" });
// Desktop settings use a portal; only the currently open project's switch is mounted.
const toggle = (compact: boolean, name: "A" | "B") =>
  (compact ? project(name) : page).getByRole("switch", { name: "AFK", exact: true });

async function openSettings(compact: boolean, name: "A" | "B") {
  if (!compact) {
    await act(async () => {
      await userEvent.click(project(name).getByRole("button", { name: /Sitrep/ }));
    });
  }
}

async function closeSettings(compact: boolean) {
  if (!compact) {
    await act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    // Wait for the closing portal to unmount before opening another project's menu.
    await expect
      .element(page.getByRole("switch", { name: "AFK", exact: true }))
      .not.toBeInTheDocument();
  }
}

describe.each([
  { name: "desktop", width: 1280, height: 900, compact: false },
  { name: "phone", width: 390, height: 844, compact: true },
])("AFK switch ($name)", ({ name, width, height, compact }) => {
  it("turns AFK on for one project only", async () => {
    await page.viewport(width, height);
    const router = await renderPmChat(compact);
    expect(document.querySelector('nav[aria-label="Views"]')).toBeNull();
    expect(document.querySelector("[data-afk-toggle]")).toBeNull();
    await openSettings(compact, "A");
    await expect.element(toggle(compact, "A")).toHaveAttribute("aria-checked", "false");
    await act(async () => {
      await userEvent.click(toggle(compact, "A"));
    });
    expect(server.patches).toEqual([{ projectId: "project-1", patch: { afk: { hours: null } } }]);
    await expect.element(toggle(compact, "A")).toHaveAttribute("aria-checked", "true");
    await expect.element(banner().getByText("AFK 켜짐 · 끌 때까지")).toBeVisible();
    expect(project("B").element().querySelector("[data-afk-banner]")).toBeNull();
    expect(banner().element().getBoundingClientRect().right).toBeLessThanOrEqual(width);
    // Let the switch finish its color transition before the screenshot.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({ path: `__screenshots__/afk-${name}.png` });

    await closeSettings(compact);
    await openSettings(compact, "B");
    await expect.element(toggle(compact, "B")).toHaveAttribute("aria-checked", "false");
    await closeSettings(compact);

    // A lead asks; after the grace period the server chooses the recommended option.
    await act(async () => server.answerWhileAfk());
    await expect.element(project("A").getByText(/자동 응답됨\(AFK\)/)).toBeVisible();
    const answered = banner().getByRole("button", { name: "1개 자동 응답" });
    await expect.element(answered).toHaveAttribute("aria-expanded", "false");
    await act(async () => {
      await userEvent.click(answered);
    });
    const row = banner().getByRole("link", { name: `${QUESTION} → ${ANSWER}`, exact: false });
    await expect.element(row).toBeVisible();
    await act(async () => {
      await userEvent.click(row);
    });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/lead-thread"));

    server.patches = [];
    await openSettings(compact, "A");
    await act(async () => {
      await userEvent.click(toggle(compact, "A"));
    });
    expect(server.patches).toEqual([{ projectId: "project-1", patch: { afk: null } }]);
    await expect.element(toggle(compact, "A")).toHaveAttribute("aria-checked", "false");
    await expect.element(banner()).not.toBeInTheDocument();
  });

  it("turns off from the banner", async () => {
    await page.viewport(width, height);
    await renderPmChat(compact);
    await openSettings(compact, "A");
    await act(async () => {
      await userEvent.click(toggle(compact, "A"));
    });
    await closeSettings(compact);
    await expect.element(banner()).toBeVisible();
    await openSettings(compact, "B");
    await act(async () => {
      await userEvent.click(toggle(compact, "B"));
    });
    await closeSettings(compact);
    await expect.element(project("B").getByRole("status", { name: "AFK" })).toBeVisible();
    server.patches = [];
    await act(async () => {
      await userEvent.click(banner().getByRole("button", { name: "끄기" }));
    });
    expect(server.patches).toEqual([{ projectId: "project-1", patch: { afk: null } }]);
    await expect.element(banner()).not.toBeInTheDocument();
    await openSettings(compact, "A");
    await expect.element(toggle(compact, "A")).toHaveAttribute("aria-checked", "false");
    await closeSettings(compact);
    await expect.element(project("B").getByRole("status", { name: "AFK" })).toBeVisible();
    await openSettings(compact, "B");
    await expect.element(toggle(compact, "B")).toHaveAttribute("aria-checked", "true");
  });
});

describe("AFK banner", () => {
  it("hides by itself when a timed window from before the switch ends", async () => {
    await page.viewport(1280, 900);
    const initial = makeProjectManagerSummaryFixture();
    const until = new Date(Date.now() + 1_500).toISOString();
    await renderPmChat(true, {
      ...initial,
      settings: { ...initial.settings, afk: { since: new Date().toISOString(), until } },
    });
    await expect.element(banner()).toBeVisible();
    await expect.element(banner().getByText(/^AFK 켜짐 · .+까지$/)).toBeVisible();
    await expect.element(banner(), { timeout: 4_000 }).not.toBeInTheDocument();
  });
});
