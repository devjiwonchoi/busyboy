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
  apply: (_projectId: string, _patch: { afk?: { hours: number | null } | null }) => {},
  /** The server answering a lead's question for the user after the grace period. */
  answerWhileAfk: () => {},
  /** Every project manager the app knows, read by useProjectManagerEntries. */
  entries: [] as Array<{ environmentId: unknown; summary: unknown }>,
}));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => server.entries) as never,
  useUpdateTeamSettings: (() => (ref: { projectId: string }, patch: never) => {
    server.patches.push({ projectId: ref.projectId, patch });
    server.apply(ref.projectId, patch);
    return Promise.resolve();
  }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (() => new Set(["env-1"])) as never,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { AfkBanner, AfkToggle } from "./Afk";
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
 * The sidebar's AFK switch beside the PM chat: its decision cards, then the composer
 * area with the banner and settings. A second project shares the workspace.
 */
function PmChat(props: { compact: boolean; initial?: ProjectTeamAttentionSummary }) {
  const [summary, setSummary] = useState(props.initial ?? makeProjectManagerSummaryFixture());
  const [other, setOther] = useState(() =>
    makeProjectManagerSummaryFixture({
      projectId: ProjectId.make(OTHER_PROJECT),
      pmThreadId: ThreadId.make("pm-thread-2"),
    }),
  );
  server.entries = [summary, other].map((entry) => ({ environmentId: "env-1", summary: entry }));
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
    <div className={props.compact ? "flex flex-col" : "flex"}>
      <nav aria-label="Views" className={props.compact ? "flex p-2" : "flex flex-col p-1"}>
        <AfkToggle compact={props.compact} />
      </nav>
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
const toggle = () => page.getByRole("switch", { name: "AFK" });

describe.each([
  { name: "desktop", width: 1280, height: 900, compact: false },
  { name: "phone", width: 390, height: 844, compact: true },
])("AFK switch ($name)", ({ width, height, compact }) => {
  it("turns AFK on for every project until turned off, shows it, and auto-answers", async () => {
    await page.viewport(width, height);
    const router = await renderPmChat(compact);
    await expect.element(banner()).not.toBeInTheDocument();
    await expect.element(toggle()).toHaveAttribute("aria-checked", "false");

    // The settings menu no longer offers AFK windows.
    if (!compact) await userEvent.click(page.getByRole("button", { name: /Sitrep/ }));
    await expect.element(page.getByText("Sitrep notifications")).toBeVisible();
    await expect.element(page.getByRole("radio", { name: "8 hours" })).not.toBeInTheDocument();
    if (!compact) await userEvent.keyboard("{Escape}");

    await userEvent.click(toggle());
    expect(server.patches).toEqual([
      { projectId: "project-1", patch: { afk: { hours: null } } },
      { projectId: OTHER_PROJECT, patch: { afk: { hours: null } } },
    ]);
    await expect.element(toggle()).toHaveAttribute("aria-checked", "true");
    await expect.element(banner()).toBeVisible();
    await expect.element(banner().getByText("AFK 켜짐 · 끌 때까지")).toBeVisible();
    const rect = banner().element().getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(width);

    // A lead asks; nobody answers within the grace period, so the server takes the
    // recommended option.
    await act(async () => server.answerWhileAfk());
    await expect.element(page.getByText(/자동 응답됨\(AFK\)/)).toBeVisible();

    const answered = banner().getByRole("button", { name: "1개 자동 응답" });
    await expect.element(answered).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(answered);
    const row = banner().getByRole("link", { name: `${QUESTION} → ${ANSWER}`, exact: false });
    await expect.element(row).toBeVisible();
    await userEvent.click(row);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/lead-thread"));

    // The switch turns it off everywhere.
    server.patches = [];
    await userEvent.click(toggle());
    expect(server.patches).toEqual([
      { projectId: "project-1", patch: { afk: null } },
      { projectId: OTHER_PROJECT, patch: { afk: null } },
    ]);
    await expect.element(toggle()).toHaveAttribute("aria-checked", "false");
    await expect.element(banner()).not.toBeInTheDocument();
  });

  it("turns off from the banner too", async () => {
    await page.viewport(width, height);
    await renderPmChat(compact);
    await userEvent.click(toggle());
    await expect.element(banner()).toBeVisible();
    server.patches = [];
    await userEvent.click(banner().getByRole("button", { name: "끄기" }));
    expect(server.patches.map(({ patch }) => patch)).toEqual([{ afk: null }, { afk: null }]);
    await expect.element(banner()).not.toBeInTheDocument();
    await expect.element(toggle()).toHaveAttribute("aria-checked", "false");
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
