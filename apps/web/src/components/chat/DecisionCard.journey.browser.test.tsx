import {
  EnvironmentId,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAttentionSummary,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { AsyncResult } from "effect/reactivity";
import { act, createRef, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
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
  server.leadMessages.push(`[User answer via BusyBoy PM] ${card.item.question} → ${input.answer}`);
  publish({
    ...current,
    openCount: current.openCount - 1,
    decisionCards: current.decisionCards.map((entry) =>
      entry === card
        ? { ...entry, item: { ...entry.item, answer: input.answer, answeredAt: ASKED_AT } }
        : entry,
    ),
  });
  return AsyncResult.success({ item: card.item });
}

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: (() =>
    useSyncExternalStore(
      (listener) => {
        server.listeners.add(listener);
        return () => server.listeners.delete(listener);
      },
      () => server.summary,
    )) as never,
  useAnswerDecision: (() => (_environmentId: EnvironmentId, input: ProjectTeamAnswerDecisionInput) =>
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
      ...overrides,
    },
  };
}

type TimelineProps = ComponentProps<typeof MessagesTimeline>;

function timelineProps(): TimelineProps {
  return {
    timelineEntries: [],
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `${ENVIRONMENT_ID}:${PM_THREAD_ID}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
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

it("shows a task lead's approval as a card in the PM thread, and Approve goes straight to the lead", async () => {
  await act(async () => root.render(<MessagesTimeline {...timelineProps()} />));
  expect(cardElement("open")).toBeNull();

  // A task lead asks for plan approval: the card appears without the PM saying anything.
  await act(async () =>
    publish({ ...server.summary!, openCount: 1, decisionCards: [card()] }),
  );
  const open = await vi.waitFor(() => {
    const element = cardElement("open");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(open.textContent).toContain("Plan approval · Fix the login redirect");
  expect(open.textContent).toContain("move the redirect into the auth guard");
  expect(open.textContent).not.toContain("#3");
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
    "[User answer via BusyBoy PM] Plan: move the redirect into the auth guard and add a regression test. → Approve",
  ]);

  // The card stays in the thread as the answered question with the pick checked.
  const answered = await vi.waitFor(() => {
    const element = cardElement("answered");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(cardElement("open")).toBeNull();
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
  await act(async () => root.render(<MessagesTimeline {...timelineProps()} />));

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
