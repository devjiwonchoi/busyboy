import {
  EnvironmentId,
  MessageId,
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
import { act, createRef, type ComponentProps, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { decisionCardsForThread } from "../../state/projectTeam.logic";
import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";
import { PendingActionsNudge } from "./PendingActionsNudge";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const ASKED_AT = "2026-11-05T03:00:00.000Z";

/** The server side: the team's questions and what reached each task lead. */
const server = vi.hoisted(() => ({
  summary: null as ProjectTeamAttentionSummary | null,
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
}));

function publish(summary: ProjectTeamAttentionSummary) {
  server.summary = summary;
  for (const listener of server.listeners) listener();
}

function useServerSummary() {
  return useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.summary,
  );
}

/** Mirrors AttentionRouter.answer: the stream then shows the card answered. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  const current = server.summary!;
  const card = current.decisionCards.find((entry) => entry.item.id === input.attentionItemId)!;
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
  useProjectManagerForThread: ((ref: { threadId: string } | null) => {
    const summary = useServerSummary();
    return ref?.threadId === PM_THREAD_ID ? summary : null;
  }) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
}));

function card(
  id: string,
  taskNumber: number,
  taskTitle: string,
  question: string,
  createdAt: string,
): ProjectDecisionCard {
  return {
    taskNumber,
    taskTitle,
    plan: null,
    item: {
      id: ProjectAttentionItemId.make(id),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make(`task-${taskNumber}`),
      kind: "decision",
      question,
      options: ["Approve", "Request changes"],
      answer: null,
      answeredAt: null,
      askerThreadId: ThreadId.make(`lead-${taskNumber}`),
      batchId: ProjectAttentionBatchId.make(`batch-${id}`),
      createdAt,
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const minute = (index: number, seconds = 0) =>
  new Date(Date.UTC(2026, 10, 5, 1, index, seconds)).toISOString();

function message(index: number): Entry {
  const createdAt = minute(index);
  return {
    id: `entry-m${index}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(`m${index}`),
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Update ${index}: still working on it.`,
      runId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

/** An hour of chat; the three questions were asked 20 minutes apart. */
const ENTRIES = Array.from({ length: 60 }, (_, index) => message(index));
const loginPlan = card(
  "attention-login",
  3,
  "Fix the login redirect",
  "Plan: move the redirect into the auth guard.",
  minute(0, 30),
);
const dragPlan = card(
  "attention-drag",
  7,
  "Fix drag scroll",
  "Plan: throttle the scroll handler.",
  minute(20, 30),
);
const cachePlan = card(
  "attention-cache",
  9,
  "Cache task pages",
  "Plan: keep the last 5 pages.",
  minute(40, 30),
);

const listRef = createRef<LegendListRef | null>();

const timelineProps: Omit<TimelineProps, "timelineEntries"> = {
  isWorking: false,
  activeTurnInProgress: false,
  listRef,
  latestRun: null,
  turnDiffSummaries: [],
  runs: [],
  routeThreadKey: `environment-local:${PM_THREAD_ID}`,
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

/** The PM chat: the real timeline and pill, with a plain textarea standing in for the composer. */
function PmChat() {
  const summary = useServerSummary();
  const cards = summary === null ? [] : decisionCardsForThread([summary], PM_THREAD_ID);
  return (
    <>
      <div data-testid="timeline" className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline {...timelineProps} timelineEntries={ENTRIES} decisionCards={cards} />
      </div>
      <div className="flex justify-center py-1.5">
        <PendingActionsNudge cards={cards} listRef={listRef} onNavigate={() => {}} />
      </div>
      <form data-testid="composer">
        <textarea aria-label="Message the PM" />
      </form>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.summary = makeProjectManagerSummaryFixture({
    pmThreadId: PM_THREAD_ID,
    taskKeyPrefix: "BB",
  });
  server.answers = [];
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 100dvh; width: 100%; display: flex; flex-direction: column;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<PmChat />));
const composer = () => container.querySelector<HTMLElement>('[data-testid="composer"]')!;
const timeline = () => container.querySelector<HTMLElement>('[data-testid="timeline"]')!;
const nudge = () => container.querySelector<HTMLElement>("[data-pending-actions-nudge]");
const cardIn = (id: string) =>
  timeline().querySelector<HTMLElement>(`[data-decision-card="${id}"]`);

function buttonIn(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll<HTMLElement>("button, [role=button]")].find(
    (candidate) => candidate.textContent?.includes(text) || candidate.ariaLabel === text,
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

function inViewport(element: HTMLElement) {
  const viewport = listRef.current!.getScrollableNode().getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.top >= viewport.top - 1 && rect.top < viewport.bottom;
}

/** Clicks the pill and waits until the card it jumps to is on screen and flashing. */
async function followNudge(expectedId: string) {
  await act(async () => nudge()!.click());
  return vi.waitFor(
    () => {
      const element = cardIn(expectedId);
      expect(element).not.toBeNull();
      expect(inViewport(element!)).toBe(true);
      expect(element!.dataset.decisionCardHighlighted).toBe("true");
      return element!;
    },
    { timeout: 3000 },
  );
}

async function pmChatWithThreeOpenCards() {
  server.summary = {
    ...server.summary!,
    openCount: 3,
    decisionCards: [cachePlan, loginPlan, dragPlan],
  };
  await render();
  await vi.waitFor(() => expect(timeline().textContent).toContain("Update 59"));
  // Nothing docks on the composer any more.
  expect(composer().querySelector("[data-decision-card]")).toBeNull();
}

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  it(`counts waiting cards, jumps to the oldest, and drops resolved ones (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await pmChatWithThreeOpenCards();

    // The chat sits at its end, so all three questions are out of view.
    const pill = await vi.waitFor(() => {
      expect(nudge()?.textContent).toBe("3 actions waiting");
      return nudge()!;
    });
    const pillRect = pill.getBoundingClientRect();
    expect(pillRect.left).toBeGreaterThanOrEqual(0);
    expect(pillRect.right).toBeLessThanOrEqual(viewport.width);

    // The pill lands on the oldest question, inline where it was asked.
    const login = await followNudge("attention-login");
    expect(login.dataset.decisionCardState).toBe("open");
    expect(login.textContent).toContain("move the redirect into the auth guard");
    // The other two are still out of view.
    expect(nudge()?.textContent).toBe("3 actions waiting");

    // Answering it there drops it from the count; it stays as the record.
    await act(async () => buttonIn(login, "Approve").click());
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]).toEqual({
      projectId: PROJECT_ID,
      attentionItemId: "attention-login",
      answer: "Approve",
    });
    await vi.waitFor(() => {
      expect(cardIn("attention-login")?.dataset.decisionCardState).toBe("answered");
      expect(nudge()?.textContent).toBe("2 actions waiting");
    });

    // Next stop: the next oldest.
    await followNudge("attention-drag");

    // The PM closes it because the conversation settled it: it shows as no longer needed.
    await act(async () =>
      publish({
        ...server.summary!,
        openCount: 1,
        decisionCards: server.summary!.decisionCards.map((entry) =>
          entry.item.id === dragPlan.item.id
            ? { ...entry, item: { ...entry.item, supersededAt: minute(59) } }
            : entry,
        ),
      }),
    );
    await vi.waitFor(() => {
      const drag = cardIn("attention-drag")!;
      expect(drag.dataset.decisionCardState).toBe("resolved");
      expect(drag.textContent).toContain("No longer needed");
      expect(drag.querySelector("button")).toBeNull();
      expect(nudge()?.textContent).toBe("1 action waiting");
    });

    // Its task is cancelled: nothing waits, so the pill goes away.
    await act(async () =>
      publish({
        ...server.summary!,
        openCount: 0,
        decisionCards: server.summary!.decisionCards.map((entry) =>
          entry.item.id === cachePlan.item.id
            ? { ...entry, item: { ...entry.item, supersededAt: minute(59) } }
            : entry,
        ),
      }),
    );
    await vi.waitFor(() => expect(nudge()).toBeNull());
    expect(server.answers).toHaveLength(1);
  });
}

it("hides the pill while every waiting card is on screen", async () => {
  await page.viewport(1100, 800);
  server.summary = { ...server.summary!, openCount: 1, decisionCards: [loginPlan] };
  await render();
  await vi.waitFor(() => expect(nudge()?.textContent).toBe("1 action waiting"));
  await followNudge("attention-login");
  await vi.waitFor(() => expect(nudge()).toBeNull());
});

it("shows a task lead's own questions in its thread, and every question in the PM thread", () => {
  const summary = {
    ...server.summary!,
    decisionCards: [
      dragPlan,
      loginPlan,
      { ...cachePlan, item: { ...cachePlan.item, answeredAt: minute(50) } },
    ],
  };
  const ids = (threadId: ThreadId) =>
    decisionCardsForThread([summary], threadId).map((entry) => entry.item.id);
  expect(ids(ThreadId.make("lead-7"))).toEqual(["attention-drag"]);
  expect(ids(ThreadId.make("lead-9"))).toEqual(["attention-cache"]);
  expect(ids(PM_THREAD_ID)).toEqual(["attention-login", "attention-drag", "attention-cache"]);
  expect(ids(ThreadId.make("other"))).toEqual([]);
});
