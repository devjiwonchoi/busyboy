import {
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAttentionSummary,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { WaitingOnYouPage } from "../inbox/WaitingOnYouPage";

const PROJECT_ID = ProjectId.make("project-1");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const LEAD_THREAD_ID = ThreadId.make("lead-thread");
const ASKED_AT = "2026-11-05T03:00:00.000Z";

/** The server side of the journey: the team's questions and the task lead's inbox. */
const server = vi.hoisted(() => ({
  summary: null as ProjectTeamAttentionSummary | null,
  listeners: new Set<() => void>(),
  leadMessages: [] as string[],
  answers: [] as ProjectTeamAnswerDecisionInput[],
}));

function publish(summary: ProjectTeamAttentionSummary) {
  server.summary = summary;
  for (const listener of server.listeners) listener();
}

/** Mirrors AttentionRouter.answer: relay to the lead, then the stream shows the card answered. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  const current = server.summary!;
  const card = current.decisionCards.find((entry) => entry.item.id === input.attentionItemId)!;
  server.leadMessages.push(`[User answer via BusyBoy] ${card.item.question} → ${input.answer}`);
  publish({
    ...current,
    openCount: current.openCount - 1,
    decisionCards: current.decisionCards.map((entry) =>
      entry === card
        ? {
            ...entry,
            item: { ...entry.item, answer: input.answer, answeredAt: ASKED_AT, answeredBy: "user" },
          }
        : entry,
    ),
  });
  return AsyncResult.success({ item: card.item });
}

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["environment-local"]) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => {
    const summary = useSyncExternalStore(
      (listener) => {
        server.listeners.add(listener);
        return () => server.listeners.delete(listener);
      },
      () => server.summary,
    );
    return summary === null ? [] : [{ environmentId: "environment-local", summary }];
  }) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
}));

function card(overrides: Partial<ProjectDecisionCard["item"]> = {}): ProjectDecisionCard {
  return {
    taskNumber: 3,
    taskTitle: "Fix the login redirect",
    item: {
      id: ProjectAttentionItemId.make("attention-plan"),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make("task-3"),
      kind: "approval",
      question: "Plan: move the redirect into the auth guard and add a regression test.",
      options: ["Approve", "Request changes"],
      answer: null,
      answeredAt: null,
      askerThreadId: LEAD_THREAD_ID,
      batchId: ProjectAttentionBatchId.make("batch-1"),
      createdAt: ASKED_AT,
      supersededAt: null,
      answeredBy: null,
      ...overrides,
    },
  };
}

/** The inbox page inside a router, since its task links need one. */
function renderInbox() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/inbox", component: WaitingOnYouPage }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks/$environmentId/$projectId/$taskId",
      component: () => null,
    }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
  });
  return act(async () => root.render(<RouterProvider router={router} />));
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.summary = makeProjectManagerSummaryFixture({ pmThreadId: PM_THREAD_ID });
  server.leadMessages = [];
  server.answers = [];
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function cardElement(state: "open" | "answered" | "superseded") {
  return container.querySelector<HTMLElement>(`[data-decision-card-state="${state}"]`);
}

function buttonIn(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

it("shows a task lead's approval in Waiting on you, and Approve goes straight to the lead", async () => {
  await renderInbox();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="waiting-on-you-empty"]')).not.toBeNull(),
  );
  expect(cardElement("open")).toBeNull();

  // A task lead asks for plan approval: the card appears without the PM saying anything.
  await act(async () => publish({ ...server.summary!, openCount: 1, decisionCards: [card()] }));
  const open = await vi.waitFor(() => {
    const element = cardElement("open");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(open.textContent).toContain("Plan approval · Fix the login redirect");
  expect(open.textContent).toContain("move the redirect into the auth guard");
  expect(open.textContent).not.toContain("#3");
  // Grouped under its task's key, with a link to the task page.
  const group = open.closest<HTMLElement>("[data-task-group]")!;
  expect(group.dataset.taskGroup).toBe("T-3");
  expect(group.textContent).toContain("T-3Fix the login redirect");
  expect(group.querySelector("a")?.getAttribute("href")).toBe(
    "/tasks/environment-local/project-1/task-3",
  );
  buttonIn(open, "Request changes");
  // Number keys stay with the composer, not every card on screen.
  expect(open.querySelector("kbd")).toBeNull();

  await act(async () => buttonIn(open, "Approve").click());
  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  expect(server.answers[0]).toEqual({
    projectId: PROJECT_ID,
    attentionItemId: "attention-plan",
    answer: "Approve",
  });
  expect(server.leadMessages).toEqual([
    "[User answer via BusyBoy] Plan: move the redirect into the auth guard and add a regression test. → Approve",
  ]);

  // Nothing is left waiting; the card moves to "Recently answered" with the pick checked.
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="waiting-on-you-empty"]')).not.toBeNull(),
  );
  const closed = container.querySelector<HTMLDetailsElement>(
    '[data-testid="waiting-on-you-closed"]',
  )!;
  expect(closed.open).toBe(false);
  await act(async () => closed.querySelector("summary")!.click());
  expect(closed.open).toBe(true);
  const answered = await vi.waitFor(() => {
    const element = cardElement("answered");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(cardElement("open")).toBeNull();
  expect(closed.contains(answered)).toBe(true);
  expect(answered.textContent).toContain("Plan approval · Fix the login redirect");
  expect(answered.textContent).toContain("move the redirect into the auth guard");
  const picked = [...answered.querySelectorAll("[data-selected=true]")].map(
    (element) => element.textContent,
  );
  expect(picked).toEqual([expect.stringContaining("Approve")]);
});

it("sends a note with the choice and shows a replaced plan as one quiet line", async () => {
  const stale = card({
    id: ProjectAttentionItemId.make("attention-old-plan"),
    question: "Plan v1: rewrite the whole router.",
    createdAt: "2026-11-05T02:00:00.000Z",
    supersededAt: ASKED_AT,
  });
  server.summary = { ...server.summary!, openCount: 1, decisionCards: [stale, card()] };
  await renderInbox();

  const replaced = await vi.waitFor(() => {
    const element = cardElement("superseded");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(replaced.textContent).toContain("replaced by a newer plan");
  expect(replaced.querySelector("button")).toBeNull();

  const open = cardElement("open")!;
  await act(async () => buttonIn(open, "Request changes").click());
  const note = await vi.waitFor(() => {
    const field = open.querySelector<HTMLTextAreaElement>("[data-pending-user-input-note]");
    expect(field).not.toBeNull();
    return field!;
  });
  await userEvent.type(note, "Keep the old redirect behind a flag");
  await act(async () => buttonIn(open, "Submit").click());

  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  expect(server.answers[0]?.answer).toBe(
    "Request changes\nNote: Keep the old redirect behind a flag",
  );
  const answered = await vi.waitFor(() => {
    const element = cardElement("answered");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(answered.querySelector("[data-answered-question-note]")?.textContent).toBe(
    "Note: Keep the old redirect behind a flag",
  );
});

it("opens a long plan full screen, and a pick with a note made there reaches the task lead", async () => {
  const steps = Array.from(
    { length: 40 },
    (_, index) => `${index + 1}. Step ${index + 1}: update the auth guard and its tests.`,
  );
  const longPlan = `Plan: move the redirect into the auth guard.\n\n${steps.join("\n")}\n\nLast line of the plan.`;
  server.summary = {
    ...server.summary!,
    openCount: 1,
    decisionCards: [card({ question: longPlan })],
  };
  await renderInbox();
  const open = await vi.waitFor(() => {
    const element = cardElement("open");
    expect(element).not.toBeNull();
    return element!;
  });

  // Inline, the long plan sits in a short scroll box.
  const inlineScroll = open.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
  expect(inlineScroll.getBoundingClientRect().height).toBeLessThanOrEqual(
    window.innerHeight * 0.4 + 1,
  );

  const expandButton = () =>
    open.querySelector<HTMLElement>('[data-pending-user-input-expand="inline"]')!;
  const expandedView = () =>
    document.querySelector<HTMLElement>(`[data-decision-card-expanded="attention-plan"]`);
  await act(async () => expandButton().click());
  const expanded = await vi.waitFor(() => {
    const element = expandedView();
    expect(element).not.toBeNull();
    return element!;
  });

  // Full screen, the whole plan is readable in a view much taller than the inline box.
  expect(expanded.textContent).toContain("Plan approval · Fix the login redirect");
  expect(expanded.textContent).toContain("Last line of the plan.");
  const expandedScroll = expanded.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
  expect(expandedScroll.getBoundingClientRect().height).toBeGreaterThan(
    inlineScroll.getBoundingClientRect().height * 1.5,
  );

  // Pick and write a note in the full-screen view.
  await act(async () => buttonIn(expanded, "Request changes").click());
  const note = await vi.waitFor(() => {
    const field = expanded.querySelector<HTMLTextAreaElement>("[data-pending-user-input-note]");
    expect(field).not.toBeNull();
    return field!;
  });
  await userEvent.type(note, "Split step 12 into two");

  // Leaving full screen keeps the draft on the inline card.
  await act(async () =>
    expanded.querySelector<HTMLElement>('[data-pending-user-input-expand="expanded"]')!.click(),
  );
  await vi.waitFor(() => expect(expandedView()).toBeNull());
  expect(open.querySelector<HTMLTextAreaElement>("[data-pending-user-input-note]")?.value).toBe(
    "Split step 12 into two",
  );
  expect(server.answers).toHaveLength(0);

  // Back to full screen to submit.
  await act(async () => expandButton().click());
  const reopened = await vi.waitFor(() => {
    const element = expandedView();
    expect(element).not.toBeNull();
    return element!;
  });
  await act(async () => buttonIn(reopened, "Submit").click());

  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  expect(server.answers[0]?.answer).toBe("Request changes\nNote: Split step 12 into two");
  expect(server.leadMessages).toEqual([
    `[User answer via BusyBoy] ${longPlan} → Request changes\nNote: Split step 12 into two`,
  ]);
  // The answered card replaces the open one, and the full-screen view closes with it.
  await vi.waitFor(() => expect(cardElement("answered")).not.toBeNull());
  await vi.waitFor(() => expect(expandedView()).toBeNull());
});
