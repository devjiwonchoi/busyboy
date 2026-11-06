import {
  EnvironmentId,
  MessageId,
  PLAN_APPROVAL_ONLY,
  PLAN_APPROVAL_START,
  PROJECT_TASK_STATUS_LABELS,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTaskStage,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAttentionSummary,
  ProjectTaskId,
  ThreadId,
  planApprovalOutcome,
  resolveProjectTaskStatus,
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
import { PendingActionsNudge } from "./PendingActionsNudge";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const AT = "2026-11-07T03:00:00.000Z";

/** The server side: the PM's cards, each task's stage, and the answers sent to the leads. */
const server = vi.hoisted(() => ({
  summary: null as ProjectTeamAttentionSummary | null,
  stages: {} as Record<string, ProjectTaskStage>,
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

/**
 * Mirrors ProjectTeamService.answerDecision for a plan: the card is answered as the user's
 * click and the task moves on (start → running, approve only → inbox).
 */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  const current = server.summary!;
  const card = current.decisionCards.find((entry) => entry.item.id === input.attentionItemId)!;
  const outcome = planApprovalOutcome(input.answer);
  server.stages[card.item.taskId] =
    outcome === "start" ? "running" : outcome === "approve_only" ? "inbox" : "planning";
  publish({
    ...current,
    openCount: current.openCount - 1,
    decisionCards: current.decisionCards.map((entry) =>
      entry === card
        ? {
            ...entry,
            item: { ...entry.item, answer: input.answer, answeredAt: AT, answeredBy: "user" },
          }
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

function planCard(id: string, taskNumber: number, title: string, summary: string, at: string) {
  return {
    taskNumber,
    taskTitle: title,
    item: {
      id: ProjectAttentionItemId.make(id),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make(`task-${taskNumber}`),
      kind: "approval",
      question: `This task fixes ${title.toLowerCase()}.`,
      options: [PLAN_APPROVAL_START, PLAN_APPROVAL_ONLY],
      answer: null,
      answeredAt: null,
      askerThreadId: ThreadId.make(`lead-${taskNumber}`),
      batchId: ProjectAttentionBatchId.make(`batch-${id}`),
      createdAt: at,
      supersededAt: null,
      answeredBy: null,
      specVersion: 2,
      summary,
    },
  } satisfies ProjectDecisionCard;
}

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const minute = (index: number, seconds = 0) =>
  new Date(Date.UTC(2026, 10, 7, 1, index, seconds)).toISOString();

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

const ENTRIES = Array.from({ length: 80 }, (_, index) => message(index));
const LOGIN_SUMMARY = [
  "What changes: the login redirect moves into the auth guard.",
  "End result: signing in always lands on the page you asked for.",
  "Done when: a regression test covers the redirect.",
  "Notable: the old /next query param is dropped.",
].join("\n");
const loginPlan = planCard("attention-login", 3, "Login redirect", LOGIN_SUMMARY, minute(10, 30));
const cachePlan = planCard(
  "attention-cache",
  9,
  "Task page cache",
  "What changes: keep the last 5 task pages in memory.",
  minute(60, 30),
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

/** The PM chat: the real timeline and pill. */
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
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.summary = {
    ...makeProjectManagerSummaryFixture({ pmThreadId: PM_THREAD_ID, taskKeyPrefix: "BB" }),
    openCount: 2,
    decisionCards: [loginPlan, cachePlan],
  };
  server.stages = { "task-3": "awaiting_approval", "task-9": "awaiting_approval" };
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

const nudge = () => container.querySelector<HTMLElement>("[data-pending-actions-nudge]");
const cardIn = (id: string) => container.querySelector<HTMLElement>(`[data-decision-card="${id}"]`);
const taskStatus = (taskId: string) =>
  PROJECT_TASK_STATUS_LABELS[
    resolveProjectTaskStatus(
      { stage: server.stages[taskId]!, lastOutcome: null },
      { openQuestion: false, leadRunning: true, leadFailed: false },
    )
  ];

function buttonIn(element: HTMLElement, name: string): HTMLButtonElement {
  const match = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}

/** Jumps to the card with the pill, as the user does from the end of the chat. */
async function jumpTo(id: string) {
  await act(async () => nudge()!.click());
  return vi.waitFor(
    () => {
      const element = cardIn(id);
      expect(element).not.toBeNull();
      return element!;
    },
    { timeout: 3000 },
  );
}

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  it(`approves a plan from its card without opening the review (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await act(async () => root.render(<PmChat />));
    await vi.waitFor(() => expect(nudge()?.textContent).toBe("2 actions waiting"));
    expect(taskStatus("task-3")).toBe("Waiting for approval");

    const login = await jumpTo("attention-login");
    expect(login.dataset.decisionCardState).toBe("open");
    // The lead's summary shows in full, not the question.
    const summary = login.querySelector<HTMLElement>("[data-plan-summary]")!;
    expect(summary.textContent).toBe(LOGIN_SUMMARY);
    expect(login.textContent).not.toContain("This task fixes");

    // The three buttons fit inside the card at this width.
    const cardRect = login.getBoundingClientRect();
    for (const name of [PLAN_APPROVAL_START, PLAN_APPROVAL_ONLY, "Review plan"]) {
      const rect = buttonIn(login, name).getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(cardRect.left);
      expect(rect.right).toBeLessThanOrEqual(cardRect.right);
    }

    await userEvent.click(buttonIn(login, PLAN_APPROVAL_START));

    // Same answer the review modal sends, and the modal never opened.
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]).toEqual({
      projectId: PROJECT_ID,
      attentionItemId: "attention-login",
      answer: PLAN_APPROVAL_START,
    });
    expect(document.querySelector("[data-plan-review]")).toBeNull();
    expect(taskStatus("task-3")).toBe("In Progress");

    // The card records the outcome and drops off the pill's count.
    await vi.waitFor(() => {
      const answered = cardIn("attention-login")!;
      expect(answered.dataset.decisionCardState).toBe("answered");
      expect(answered.textContent).toContain("Approved and started");
      expect(nudge()?.textContent).toBe("1 action waiting");
    });

    // "Approve only" parks the other plan for later.
    const cache = await jumpTo("attention-cache");
    await userEvent.click(buttonIn(cache, PLAN_APPROVAL_ONLY));
    await vi.waitFor(() => expect(server.answers).toHaveLength(2));
    expect(server.answers[1]!.answer).toBe(PLAN_APPROVAL_ONLY);
    expect(taskStatus("task-9")).toBe("Todo");
    await vi.waitFor(() => {
      expect(cardIn("attention-cache")?.textContent).toContain("Approved");
      expect(nudge()).toBeNull();
    });
  });
}
