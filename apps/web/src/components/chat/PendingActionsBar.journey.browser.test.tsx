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
  type ProjectWaitingThread,
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
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  PendingBar,
  followPendingAction,
  pendingBar,
  pendingBarIcon,
} from "./PendingActionsBar.testing";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const ASKED_AT = "2026-11-05T03:00:00.000Z";

/** The server side: the team's questions and what reached each task lead. */
const server = vi.hoisted(() => ({
  summary: null as ProjectTeamAttentionSummary | null,
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
  opened: [] as ThreadId[],
  subagentRunning: true,
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
  kind: ProjectDecisionCard["item"]["kind"] = "decision",
): ProjectDecisionCard {
  return {
    taskNumber,
    taskTitle,
    proposal: null,
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

/** What the composer showed in the screenshot: a subagent the PM is waiting on. */
const SUBAGENT_BANNER: ComposerBannerStackItem = {
  id: "background-work",
  variant: "default",
  priority: "activity",
  icon: <span data-subagent-banner style={{ width: 6, height: 6, borderRadius: 9 }} />,
  title: "Waiting on subagent BU-79 project map review",
  actions: (
    <Button size="xs" variant="ghost">
      Stop
    </Button>
  ),
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

/** The PM chat: the real timeline, the composer's banner stack and a stand-in composer. */
function PmChat({ subagentRunning }: { subagentRunning: boolean }) {
  const summary = useServerSummary();
  const cards = summary === null ? [] : decisionCardsForThread([summary], PM_THREAD_ID);
  return (
    <>
      <div data-testid="timeline" className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline {...timelineProps} timelineEntries={ENTRIES} decisionCards={cards} />
      </div>
      <div style={{ padding: "0 12px 12px" }}>
        <PendingBar
          cards={cards}
          waitingThreads={summary?.waitingThreads ?? []}
          listRef={listRef}
          onOpenThread={(threadId) => server.opened.push(threadId)}
          otherItems={subagentRunning ? [SUBAGENT_BANNER] : []}
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
  server.opened = [];
  server.subagentRunning = true;
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 100dvh; width: 100%; display: flex; flex-direction: column;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(async () => root.render(<PmChat subagentRunning={server.subagentRunning} />));
const timeline = () => container.querySelector<HTMLElement>('[data-testid="timeline"]')!;
const cardIn = (id: string) =>
  timeline().querySelector<HTMLElement>(`[data-decision-card="${id}"]`);
/** The banner attached to the composer: the one the user sees first. */
const frontBanner = () =>
  container.querySelector<HTMLElement>("[data-composer-banner-drawer] [role=alert]");

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

/** Waits until the card the bar jumped to is on screen and flashing. */
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

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  it(`shows an out-of-view blocker in front of the subagent status and jumps to it (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat({ openCount: 1, decisionCards: [loginBlocker] });

    // The chat sits at its end, so the blocker is far out of view; the bar still names it,
    // in front of the subagent status.
    const front = await vi.waitFor(() => {
      expect(frontBanner()?.textContent).toContain("블로커: Fix the login redirect");
      return frontBanner()!;
    });
    expect(pendingBarIcon()?.dataset.pendingActionsBar).toBe("1");
    expect(cardIn("attention-login") === null || !inViewport(cardIn("attention-login")!)).toBe(
      true,
    );
    expectInsideViewport(front, viewport.width);
    expect(container.textContent).not.toContain("action waiting");

    // Tapping 보기 scrolls to the card where it was asked and flashes it.
    await followPendingAction("attention-login");
    const login = await expectRevealed("attention-login");
    expect(login.dataset.decisionCardState).toBe("open");

    // On screen or not, the bar stays while the blocker is open.
    expect(pendingBar()?.textContent).toContain("블로커: Fix the login redirect");

    // The blocker resolves: the bar goes away and the subagent status is in front again.
    await act(async () =>
      publish({
        ...server.summary!,
        openCount: 0,
        decisionCards: [
          { ...loginBlocker, item: { ...loginBlocker.item, supersededAt: minute(59) } },
        ],
      }),
    );
    await vi.waitFor(() => {
      expect(pendingBarIcon()).toBeNull();
      expect(frontBanner()?.textContent).toContain("Waiting on subagent");
    });
  });

  it(`shows another thread waiting on the user and opens it (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat({ openCount: 1, waitingThreads: [cuThread] });

    await vi.waitFor(() =>
      expect(frontBanner()?.textContent).toContain("CU eval chrome-form #1 · 허용 요청"),
    );
    expectInsideViewport(frontBanner()!, viewport.width);
    await followPendingAction(CU_THREAD_ID);
    expect(server.opened).toEqual([CU_THREAD_ID]);
  });

  it(`steps through waiting items in order and wraps (${viewport.name})`, async () => {
    await page.viewport(viewport.width, viewport.height);
    await openPmChat({
      openCount: 3,
      decisionCards: [cachePlan, loginBlocker],
      waitingThreads: [cuThread],
    });

    await vi.waitFor(() => expect(frontBanner()?.textContent).toContain("기다리는 일 1/3"));
    expect(pendingBarIcon()?.dataset.pendingActionsBar).toBe("3");
    expectInsideViewport(frontBanner()!, viewport.width);

    // The first click reveals the oldest card; subsequent clicks advance and wrap.
    expect(
      page.getByRole("button", { name: "기다리는 일 보기", exact: true }).element().textContent,
    ).toBe("보기");
    await followPendingAction("attention-login");
    await expectRevealed("attention-login");
    expect(
      page.getByRole("button", { name: "다음 기다리는 일", exact: true }).element().textContent,
    ).toBe("다음");
    expect(frontBanner()?.textContent).toContain("기다리는 일 1/3 · 블로커:");
    await followPendingAction("attention-cache");
    await expectRevealed("attention-cache");
    expect(frontBanner()?.textContent).toContain("기다리는 일 2/3");
    await followPendingAction(CU_THREAD_ID);
    expect(server.opened).toEqual([CU_THREAD_ID]);
    expect(frontBanner()?.textContent).toContain("기다리는 일 3/3");
    await followPendingAction("attention-login");
    await expectRevealed("attention-login");
    expect(frontBanner()?.textContent).toContain("기다리는 일 1/3");
  });
}

it("hides the bar when nothing waits, leaving the subagent status", async () => {
  await page.viewport(1100, 800);
  await openPmChat({
    openCount: 0,
    decisionCards: [{ ...dragPlan, item: { ...dragPlan.item, answeredAt: minute(30) } }],
  });
  await vi.waitFor(() => expect(frontBanner()?.textContent).toContain("Waiting on subagent"));
  expect(pendingBarIcon()).toBeNull();

  // The subagent finishes too: nothing is left above the composer.
  server.subagentRunning = false;
  await render();
  await vi.waitFor(() => expect(frontBanner()).toBeNull());
  expect(pendingBarIcon()).toBeNull();
});

it("answering the last card from the timeline clears the bar", async () => {
  await page.viewport(1100, 800);
  server.subagentRunning = false;
  await openPmChat({ openCount: 1, decisionCards: [dragPlan] });
  await vi.waitFor(() => expect(pendingBar()?.textContent).toContain("결정 필요: Fix drag scroll"));
  await followPendingAction("attention-drag");
  const drag = await expectRevealed("attention-drag");
  await act(async () => buttonIn(drag, "Approve").click());
  await act(async () => buttonIn(drag, "Submit").click());
  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  await vi.waitFor(() => expect(pendingBarIcon()).toBeNull());
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
