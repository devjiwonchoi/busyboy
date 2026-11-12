import {
  EnvironmentId,
  MessageId,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamSnoozeDecisionInput,
  type ProjectTeamUnsnoozeDecisionInput,
  type ProjectTeamAttentionSummary,
  ProjectTaskId,
  type ProjectWaitingThread,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { AsyncResult } from "effect/reactivity";
import { act, createRef, type ComponentProps, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { decisionCardsForThread } from "../../state/projectTeam.logic";
import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  PendingActions,
  openPendingActions,
  pendingButton,
  pendingDialog,
  revealPendingCard,
} from "./PendingActionsButton.testing";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const ASKED_AT = "2026-11-05T03:00:00.000Z";

/** The server side: the team's questions and what reached each task lead. */
const server = vi.hoisted(() => ({
  summary: null as ProjectTeamAttentionSummary | null,
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
  snoozes: [] as ProjectTeamSnoozeDecisionInput[],
  opened: [] as ThreadId[],
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

/** Mirrors ProjectTeamService.snoozeDecision: the card stays open, marked snoozed. */
function setSnooze(attentionItemId: string, reason: string | null) {
  const current = server.summary!;
  const card = current.decisionCards.find((entry) => entry.item.id === attentionItemId)!;
  const item = {
    ...card.item,
    snoozedAt: reason === null ? null : ASKED_AT,
    snoozeReason: reason,
  };
  publish({
    ...current,
    openCount: current.openCount + (reason === null ? 1 : -1),
    decisionCards: current.decisionCards.map((entry) =>
      entry === card ? { ...entry, item } : entry,
    ),
  });
  return AsyncResult.success({ item });
}

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: ((ref: { threadId: string } | null) => {
    const summary = useServerSummary();
    return ref?.threadId === PM_THREAD_ID ? summary : null;
  }) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
  useSnoozeDecision: (() =>
    async (_environmentId: unknown, input: ProjectTeamSnoozeDecisionInput) => {
      server.snoozes.push(input);
      return setSnooze(input.attentionItemId, input.reason);
    }) as never,
  useUnsnoozeDecision: (() =>
    async (_environmentId: unknown, input: ProjectTeamUnsnoozeDecisionInput) =>
      setSnooze(input.attentionItemId, null)) as never,
}));

function card(
  id: string,
  taskNumber: number,
  taskTitle: string,
  question: string,
  createdAt: string,
  kind: ProjectDecisionCard["item"]["kind"] = "decision",
): ProjectDecisionCard {
  return {
    taskNumber,
    taskTitle,
    plan: null,
    item: {
      id: ProjectAttentionItemId.make(id),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make(`task-${taskNumber}`),
      kind,
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
      details: null,
      senderRole: null,
      senderName: null,
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

/** An hour of chat; the blocker was raised at its start, far above the end. */
const ENTRIES = Array.from({ length: 60 }, (_, index) => message(index));
const loginBlocker = card(
  "attention-login",
  3,
  "Fix the login redirect",
  "The staging login needs a person to sign in once.",
  minute(0, 30),
  "blocker",
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
const CU_THREAD_ID = ThreadId.make("thread-cu-eval");
const cuThread: ProjectWaitingThread = {
  threadId: CU_THREAD_ID,
  title: "CU eval chrome-form #1",
  kind: "approval",
};

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

/** The PM chat: the real timeline, the floating pill and a stand-in composer. */
function PmChat() {
  const summary = useServerSummary();
  const cards = summary === null ? [] : decisionCardsForThread([summary], PM_THREAD_ID);
  return (
    <>
      <div data-testid="timeline" className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline {...timelineProps} timelineEntries={ENTRIES} decisionCards={cards} />
      </div>
      <div style={{ padding: "0 12px 12px" }}>
        <PendingActions
          cards={cards}
          waitingThreads={summary?.waitingThreads ?? []}
          listRef={listRef}
          threadId={PM_THREAD_ID}
          onOpenThread={(threadId) => server.opened.push(threadId)}
        />
        <form
          data-testid="composer"
          style={{ maxWidth: 720, margin: "0 auto", border: "1px solid #ddd", borderRadius: 16 }}
        >
          <textarea aria-label="Message the PM" style={{ width: "100%", border: 0, padding: 12 }} />
        </form>
      </div>
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
  server.snoozes = [];
  server.opened = [];
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
const timeline = () => container.querySelector<HTMLElement>('[data-testid="timeline"]')!;
const cardIn = (id: string) =>
  timeline().querySelector<HTMLElement>(`[data-decision-card="${id}"]`);
const dialogCards = () =>
  [...(pendingDialog()?.querySelectorAll<HTMLElement>("[data-pending-actions-card]") ?? [])].map(
    (row) => row.dataset.pendingActionsCard,
  );

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

/** Waits until the card the dialog jumped to is on screen and flashing. */
function expectRevealed(id: string) {
  return vi.waitFor(
    () => {
      const element = cardIn(id);
      expect(element).not.toBeNull();
      expect(inViewport(element!)).toBe(true);
      expect(element!.dataset.decisionCardHighlighted).toBe("true");
      return element!;
    },
    { timeout: 3000 },
  );
}

async function openPmChat(summary: Partial<ProjectTeamAttentionSummary>) {
  server.summary = { ...server.summary!, ...summary };
  await render();
  await vi.waitFor(() => expect(timeline().textContent).toContain("Update 59"));
}

function expectInsideViewport(element: HTMLElement, width: number) {
  const rect = element.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(width + 0.5);
}

const ALL_WAITING = {
  openCount: 4,
  decisionCards: [loginBlocker, dragPlan, cachePlan],
  waitingThreads: [cuThread],
} satisfies Partial<ProjectTeamAttentionSummary>;

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  it(`shows a small waiting button that opens every waiting item (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat(ALL_WAITING);

    // No inbox or stepping banner, just a small pill with the count.
    const pill = await vi.waitFor(() => {
      const button = pendingButton();
      if (!button) throw new Error("no pending button yet");
      return button;
    });
    expect(pill.textContent).toBe("기다리는 일 4개");
    expect(pill.dataset.pendingActionsButton).toBe("4");
    expect(pill.getBoundingClientRect().height).toBeLessThanOrEqual(32);
    expectInsideViewport(pill, viewport.width);
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(document.body.textContent).not.toContain("받은편지함");
    expect(document.body.textContent).not.toContain("기다리는 일 1/");
    await page.screenshot({ path: `__screenshots__/pending-actions-button-${viewport.name}.png` });

    // The dialog lists every open card and the waiting thread.
    const dialog = await openPendingActions();
    expect(dialog.textContent).toContain("나를 기다리는 일 4");
    expect(dialogCards()).toEqual(["attention-login", "attention-drag", "attention-cache"]);
    expect(dialog.textContent).toContain("블로커: Fix the login redirect");
    expect(dialog.textContent).toContain("Plan: throttle the scroll handler.");
    expect(dialog.textContent).toContain("CU eval chrome-form #1 · 허용 요청");
    expectInsideViewport(dialog, viewport.width);
    await page.screenshot({ path: `__screenshots__/pending-actions-${viewport.name}.png` });
  });

  it(`answers a card inside the dialog and the count drops (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat(ALL_WAITING);
    await vi.waitFor(() => expect(pendingButton()).not.toBeNull());
    const dialog = await openPendingActions();
    const drag = dialog.querySelector<HTMLElement>('[data-pending-actions-card="attention-drag"]')!;
    // The waiting window shows the same one-bubble message as the chat.
    expect(drag.querySelector("[data-request-bubble]")).not.toBeNull();
    await act(async () => buttonIn(drag, "승인").click());
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]?.attentionItemId).toBe("attention-drag");

    await vi.waitFor(() => {
      expect(pendingButton()?.textContent).toBe("기다리는 일 3개");
      expect(dialogCards()).toEqual(["attention-login", "attention-cache"]);
      expect(pendingDialog()?.textContent).toContain("나를 기다리는 일 3");
    });
  });

  it(`jumps from the dialog to a card in the chat (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat(ALL_WAITING);
    await vi.waitFor(() => expect(pendingButton()).not.toBeNull());
    // The chat sits at its end, so the oldest blocker is far out of view.
    expect(cardIn("attention-login") === null || !inViewport(cardIn("attention-login")!)).toBe(
      true,
    );

    await revealPendingCard("attention-login");
    await vi.waitFor(() => expect(pendingDialog()).toBeNull());
    const login = await expectRevealed("attention-login");
    expect(login.dataset.decisionCardState).toBe("open");
  });

  it(`opens a waiting thread from the dialog (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat(ALL_WAITING);
    await vi.waitFor(() => expect(pendingButton()).not.toBeNull());
    const dialog = await openPendingActions();
    const row = dialog.querySelector<HTMLElement>(
      `[data-pending-actions-thread="${CU_THREAD_ID}"]`,
    )!;
    await act(async () => buttonIn(row, "열기").click());
    expect(server.opened).toEqual([CU_THREAD_ID]);
    await vi.waitFor(() => expect(pendingDialog()).toBeNull());
  });
}

it("hides the button when nothing waits", async () => {
  await page.viewport(1100, 800);
  await openPmChat({
    openCount: 0,
    decisionCards: [{ ...dragPlan, item: { ...dragPlan.item, answeredAt: minute(30) } }],
  });
  expect(pendingButton()).toBeNull();
});

it("answering the last card closes the dialog and hides the button", async () => {
  await page.viewport(1100, 800);
  await openPmChat({ openCount: 1, decisionCards: [dragPlan] });
  await vi.waitFor(() => expect(pendingButton()?.textContent).toBe("기다리는 일 1개"));
  const dialog = await openPendingActions();
  const drag = dialog.querySelector<HTMLElement>('[data-pending-actions-card="attention-drag"]')!;
  await act(async () => buttonIn(drag, "승인").click());
  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  await vi.waitFor(() => {
    expect(pendingButton()).toBeNull();
    expect(pendingDialog()).toBeNull();
  });

  // A new card later shows the button again without reopening the dialog.
  await act(async () => publish({ ...server.summary!, openCount: 1, decisionCards: [cachePlan] }));
  await vi.waitFor(() => expect(pendingButton()?.textContent).toBe("기다리는 일 1개"));
  expect(pendingDialog()).toBeNull();
});

it("shows a task lead's own questions in its thread, and every question in the PM thread", () => {
  const summary = {
    ...server.summary!,
    decisionCards: [
      dragPlan,
      loginBlocker,
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

it("snoozes a card only with a reason and brings it back", async () => {
  await page.viewport(1100, 800);
  await openPmChat(ALL_WAITING);
  const dialog = await vi.waitFor(() => openPendingActions(), { timeout: 3000 });
  const row = () =>
    dialog.querySelector<HTMLElement>(`[data-pending-actions-card="${dragPlan.item.id}"]`);

  await act(async () =>
    userEvent.click(row()!.querySelector<HTMLElement>("[data-snooze-button]")!),
  );
  const input = await vi.waitFor(() => {
    const element = row()!.querySelector<HTMLInputElement>("[data-snooze-reason-input]");
    expect(element).not.toBeNull();
    expect(document.activeElement).toBe(element);
    return element!;
  });
  const submit = row()!.querySelector<HTMLButtonElement>("[data-snooze-submit]")!;
  // No reason, no snooze: the button stays off even for spaces.
  expect(submit.disabled).toBe(true);
  await act(async () => userEvent.type(input, "   "));
  expect(submit.disabled).toBe(true);
  expect(server.snoozes).toEqual([]);

  await act(async () => userEvent.type(input, "다음 주에 볼게"));
  await vi.waitFor(() => expect(input.value).toBe("   다음 주에 볼게"));
  expect(submit.disabled).toBe(false);
  await act(async () => userEvent.click(submit));

  expect(server.snoozes).toEqual([
    { projectId: PROJECT_ID, attentionItemId: dragPlan.item.id, reason: "다음 주에 볼게" },
  ]);
  // The card leaves the waiting list and count, and waits under "보류 1" with its reason.
  await vi.waitFor(() => {
    expect(dialogCards()).toEqual([loginBlocker.item.id, cachePlan.item.id]);
    expect(pendingButton()?.textContent).toBe("기다리는 일 3개");
    const section = dialog.querySelector<HTMLElement>("[data-snoozed-section]");
    expect(section?.querySelector("summary")?.textContent).toBe("보류 1");
    const snoozed = section?.querySelector<HTMLElement>(
      `[data-snoozed-card="${dragPlan.item.id}"]`,
    );
    expect(snoozed?.textContent).toContain("결정 필요: Fix drag scroll");
    expect(snoozed?.textContent).toContain("이유: 다음 주에 볼게");
  });

  const section = dialog.querySelector<HTMLDetailsElement>("[data-snoozed-section]")!;
  await act(async () => userEvent.click(section.querySelector("summary")!));
  await vi.waitFor(() => expect(section.open).toBe(true));
  await act(async () =>
    userEvent.click(section.querySelector<HTMLElement>("[data-unsnooze-button]")!),
  );

  // Back in its place, and the snoozed section is gone.
  await vi.waitFor(() => {
    expect(dialogCards()).toEqual([loginBlocker.item.id, dragPlan.item.id, cachePlan.item.id]);
    expect(pendingButton()?.textContent).toBe("기다리는 일 4개");
    expect(dialog.querySelector("[data-snoozed-section]")).toBeNull();
  });
});
