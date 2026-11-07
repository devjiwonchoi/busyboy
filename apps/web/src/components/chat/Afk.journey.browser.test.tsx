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
  patches: [] as Array<unknown>,
  apply: (_patch: { afk?: { hours: number | null } | null }) => {},
  /** The server answering a lead's question for the user after the grace period. */
  answerWhileAfk: () => {},
}));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useUpdateTeamSettings: (() => (_ref: unknown, patch: never) => {
    server.patches.push(patch);
    server.apply(patch);
    return Promise.resolve();
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { AfkBanner } from "./Afk";
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

/** The PM chat: its decision cards, then the composer area with the banner and settings. */
function PmChat(props: { compact: boolean; initial?: ProjectTeamAttentionSummary }) {
  const [summary, setSummary] = useState(props.initial ?? makeProjectManagerSummaryFixture());
  server.apply = (patch) => {
    if (patch.afk === undefined) return;
    setSummary((current): ProjectTeamAttentionSummary => {
      const { afk: _old, ...settings } = current.settings;
      const choice = patch.afk;
      if (choice === null || choice === undefined) {
        return { ...current, settings, afkAnswers: [] };
      }
      const since = new Date().toISOString();
      const until =
        choice.hours === null
          ? null
          : new Date(Date.now() + choice.hours * 3_600_000).toISOString();
      return { ...current, settings: { ...settings, afk: { since, until } }, afkAnswers: [] };
    });
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
    <div className="mx-auto w-full max-w-2xl p-3">
      {summary.decisionCards.map((card) => (
        <DecisionCard
          key={card.item.id}
          card={card}
          environmentId={projectRef.environmentId}
          threadRef={scopeThreadRef(projectRef.environmentId, summary.pmThreadId)}
          cwd={undefined}
        />
      ))}
      <AfkBanner projectRef={projectRef} summary={summary} />
      <div className="rounded-xl border p-2">
        {props.compact ? (
          // Phones show the sitrep settings inside the composer's overflow menu.
          <SitrepSettingsContent projectRef={projectRef} summary={summary} />
        ) : (
          <SitrepIntervalPicker projectRef={projectRef} summary={summary} />
        )}
      </div>
    </div>
  );
}

async function renderPmChat(compact: boolean, initial?: ProjectTeamAttentionSummary) {
  const rootRoute = createRootRoute({
    component: () => <PmChat compact={compact} {...(initial ? { initial } : {})} />,
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

const banner = () => page.getByRole("status", { name: "AFK" });

describe.each([
  { name: "desktop", width: 1280, height: 900, compact: false },
  { name: "phone", width: 390, height: 844, compact: true },
])("AFK in the PM chat ($name)", ({ width, height, compact }) => {
  it("turns on for 8 hours, shows what was auto-answered, and turns off", async () => {
    await page.viewport(width, height);
    const router = await renderPmChat(compact);
    await expect.element(banner()).not.toBeInTheDocument();

    if (!compact) await userEvent.click(page.getByRole("button", { name: /Sitrep/ }));
    await expect.element(page.getByText(/Blockers, merges and secrets still wait/)).toBeVisible();
    const off = page.getByRole("radio", { name: "Off" });
    await expect.element(off).toHaveAttribute("aria-checked", "true");
    await userEvent.click(page.getByRole("radio", { name: "8 hours" }));
    expect(server.patches).toEqual([{ afk: { hours: 8 } }]);

    await expect.element(banner()).toBeVisible();
    await expect.element(banner().getByText(/^AFK on · until \S*\d/)).toBeVisible();
    await expect
      .element(page.getByRole("radio", { name: "8 hours" }))
      .toHaveAttribute("aria-checked", "true");
    const rect = banner().element().getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(width);
    if (!compact) await userEvent.keyboard("{Escape}");

    // A lead asks; nobody answers within the grace period, so the server takes the
    // recommended option.
    await act(async () => server.answerWhileAfk());
    await expect.element(page.getByText(/Auto-answered \(AFK\)/)).toBeVisible();

    const toggle = banner().getByRole("button", { name: "1 auto-answered" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const row = banner().getByRole("link", { name: `${QUESTION} → ${ANSWER}`, exact: false });
    await expect.element(row).toBeVisible();
    await userEvent.click(row);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/lead-thread"));

    await userEvent.click(banner().getByRole("button", { name: "Turn off" }));
    expect(server.patches.at(-1)).toEqual({ afk: null });
    await expect.element(banner()).not.toBeInTheDocument();
  });
});

describe("AFK banner", () => {
  it("hides by itself when the window ends", async () => {
    await page.viewport(1280, 900);
    const initial = makeProjectManagerSummaryFixture();
    const until = new Date(Date.now() + 1_500).toISOString();
    await renderPmChat(true, {
      ...initial,
      settings: { ...initial.settings, afk: { since: new Date().toISOString(), until } },
    });
    await expect.element(banner()).toBeVisible();
    await expect.element(banner(), { timeout: 4_000 }).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("radio", { name: "Off" }))
      .toHaveAttribute("aria-checked", "true");
  });
});
