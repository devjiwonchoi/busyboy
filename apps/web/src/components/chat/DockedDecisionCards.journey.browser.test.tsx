import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { useDockedDecisionCards } from "../../state/projectTeam";
import { dockedDecisionCardsForThread } from "../../state/projectTeam.logic";
import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { ComposerBanner } from "./ComposerBanner";
import { DockedDecisionCards } from "./DockedDecisionCards";
import { MessagesTimeline } from "./MessagesTimeline";

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
  useDockedDecisionCards: ((ref: { threadId: ThreadId } | null) => {
    const summary = useServerSummary();
    if (ref === null || summary === null) return [];
    return dockedDecisionCardsForThread([summary], ref.threadId);
  }) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
}));

function card(
  id: string,
  taskNumber: number,
  taskTitle: string,
  question: string,
  createdAt = ASKED_AT,
): ProjectDecisionCard {
  return {
    taskNumber,
    taskTitle,
    item: {
      id: ProjectAttentionItemId.make(id),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make(`task-${taskNumber}`),
      kind: "approval",
      question,
      options: ["Approve", "Request changes"],
      answer: null,
      answeredAt: null,
      askerThreadId: ThreadId.make(`lead-${taskNumber}`),
      batchId: ProjectAttentionBatchId.make(`batch-${id}`),
      createdAt,
      supersededAt: null,
      answeredBy: null,
    },
  };
}

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

function message(id: string, text: string, role: "user" | "assistant"): Entry {
  const createdAt = "2026-11-05T02:00:00.000Z";
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

const timelineProps: Omit<TimelineProps, "timelineEntries"> = {
  isWorking: false,
  activeTurnInProgress: false,
  listRef: createRef<LegendListRef | null>(),
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

/** The PM chat: the real timeline and dock, with a plain textarea standing in for the composer. */
function PmChat({ entries }: { entries: Entry[] }) {
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, PM_THREAD_ID);
  const cards = useDockedDecisionCards(threadRef);
  return (
    <>
      <div data-testid="timeline" className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline {...timelineProps} timelineEntries={entries} />
      </div>
      <form data-chat-composer-form="true" data-testid="composer">
        <ComposerBanner.Dock>
          <ComposerBanner.Column>
            {cards.length > 0 ? (
              <DockedDecisionCards
                cards={cards}
                environmentId={ENVIRONMENT_ID}
                threadRef={threadRef}
                cwd={undefined}
              />
            ) : null}
          </ComposerBanner.Column>
        </ComposerBanner.Dock>
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
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (entries: Entry[]) => act(async () => root.render(<PmChat entries={entries} />));
const composer = () => container.querySelector<HTMLElement>('[data-testid="composer"]')!;
const timeline = () => container.querySelector<HTMLElement>('[data-testid="timeline"]')!;
const dock = () => container.querySelector<HTMLElement>("[data-docked-decision-cards]");
const position = () => dock()?.querySelector("[data-docked-decision-position]")?.textContent;

function buttonIn(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll<HTMLElement>("button, [role=button]")].find(
    (candidate) => candidate.textContent?.includes(text) || candidate.ariaLabel === text,
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

const loginPlan = card(
  "attention-login",
  3,
  "Fix the login redirect",
  "Plan: move the redirect into the auth guard.",
  "2026-11-05T01:00:00.000Z",
);
const dragPlan = card(
  "attention-drag",
  7,
  "Fix drag scroll",
  "Plan: throttle the scroll handler.",
  "2026-11-05T01:30:00.000Z",
);
const cachePlan = card("attention-cache", 9, "Cache task pages", "Plan: keep the last 5 pages.");

it("docks an open card above the PM composer and keeps it there as messages arrive", async () => {
  const entries = [message("hello", "How is it going?", "user")];
  await render(entries);
  expect(dock()).toBeNull();

  // A task lead asks for plan approval: it docks right above the composer, not in the history.
  await act(async () => publish({ ...server.summary!, openCount: 1, decisionCards: [loginPlan] }));
  const docked = await vi.waitFor(() => {
    expect(dock()).not.toBeNull();
    return dock()!;
  });
  expect(composer().contains(docked)).toBe(true);
  expect(timeline().querySelector("[data-decision-card]")).toBeNull();
  // The card says which task asked, by key and title. One card needs no pager.
  expect(docked.textContent).toContain("Plan approval · BB-3 Fix the login redirect");
  expect(docked.textContent).toContain("move the redirect into the auth guard");
  expect(docked.querySelector("[data-docked-decision-pager]")).toBeNull();
  // Like a pending question, it sits on the composer's top edge.
  const textareaTop = composer().querySelector("textarea")!.getBoundingClientRect().top;
  expect(docked.getBoundingClientRect().top).toBeLessThan(textareaTop);
  expect(docked.getBoundingClientRect().bottom).toBeLessThanOrEqual(textareaTop + 17);

  // The conversation goes on; the card stays docked above the composer.
  const longer = [
    ...entries,
    ...Array.from({ length: 30 }, (_, index) =>
      message(`m${index}`, `Update ${index}: still working on it.`, "assistant"),
    ),
  ];
  await render(longer);
  await vi.waitFor(() => expect(timeline().textContent).toContain("Update 29"));
  expect(dock()?.textContent).toContain("BB-3 Fix the login redirect");
  expect(composer().contains(dock())).toBe(true);
});

it("answers a docked card in place: it leaves the dock and stays in the history as answered", async () => {
  server.summary = { ...server.summary!, openCount: 1, decisionCards: [loginPlan] };
  await render([message("hello", "How is it going?", "user")]);
  const docked = await vi.waitFor(() => {
    expect(dock()).not.toBeNull();
    return dock()!;
  });

  await act(async () => buttonIn(docked, "Approve").click());
  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  // The answer goes straight to the task that asked.
  expect(server.answers[0]).toEqual({
    projectId: PROJECT_ID,
    attentionItemId: "attention-login",
    answer: "Approve",
  });

  await vi.waitFor(() => expect(dock()).toBeNull());
  const answered = await vi.waitFor(() => {
    const element = timeline().querySelector<HTMLElement>('[data-decision-card-state="answered"]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect(answered.textContent).toContain("Plan approval · Fix the login redirect");
  const picked = [...answered.querySelectorAll("[data-selected=true]")].map(
    (element) => element.textContent,
  );
  expect(picked).toEqual([expect.stringContaining("Approve")]);
});

it("pages through several open cards and answers each where it is", async () => {
  server.summary = {
    ...server.summary!,
    openCount: 3,
    decisionCards: [cachePlan, loginPlan, dragPlan],
  };
  await render([message("hello", "How is it going?", "user")]);
  const docked = await vi.waitFor(() => {
    expect(dock()).not.toBeNull();
    return dock()!;
  });

  // Oldest question first.
  expect(position()).toBe("1/3");
  expect(docked.textContent).toContain("BB-3 Fix the login redirect");
  expect(buttonIn(docked, "Previous card")).toHaveProperty("disabled", true);

  await act(async () => buttonIn(docked, "Next card").click());
  expect(position()).toBe("2/3");
  expect(dock()!.textContent).toContain("BB-7 Fix drag scroll");

  await act(async () => buttonIn(dock()!, "Next card").click());
  expect(position()).toBe("3/3");
  expect(dock()!.textContent).toContain("BB-9 Cache task pages");
  expect(buttonIn(dock()!, "Next card")).toHaveProperty("disabled", true);

  // Answering the last card leaves two; the pager shows the one before it.
  await act(async () => buttonIn(dock()!, "Request changes").click());
  const note = await vi.waitFor(() => {
    const field = dock()!.querySelector<HTMLTextAreaElement>("[data-pending-user-input-note]");
    expect(field).not.toBeNull();
    return field!;
  });
  await userEvent.type(note, "Keep 10");
  await act(async () => buttonIn(dock()!, "Submit").click());
  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  expect(server.answers[0]?.attentionItemId).toBe("attention-cache");
  await vi.waitFor(() => expect(position()).toBe("2/2"));
  expect(dock()!.textContent).toContain("BB-7 Fix drag scroll");

  await act(async () => buttonIn(dock()!, "Previous card").click());
  expect(position()).toBe("1/2");
  await act(async () => buttonIn(dock()!, "Approve").click());
  await vi.waitFor(() => expect(server.answers).toHaveLength(2));
  expect(server.answers[1]?.attentionItemId).toBe("attention-login");

  // One card left: no pager, and it can still be answered.
  await vi.waitFor(() => expect(dock()?.querySelector("[data-docked-decision-pager]")).toBeNull());
  expect(dock()!.textContent).toContain("BB-7 Fix drag scroll");
  await act(async () => buttonIn(dock()!, "Approve").click());
  await vi.waitFor(() => expect(dock()).toBeNull());
  expect(timeline().querySelectorAll('[data-decision-card-state="answered"]')).toHaveLength(3);
});

it("docks a task lead's own questions in its thread, and only those", () => {
  const summary = {
    ...server.summary!,
    decisionCards: [
      loginPlan,
      dragPlan,
      { ...cachePlan, item: { ...cachePlan.item, answeredAt: ASKED_AT } },
    ],
  };
  expect(
    dockedDecisionCardsForThread([summary], ThreadId.make("lead-7")).map((entry) => entry.taskKey),
  ).toEqual(["BB-7"]);
  expect(
    dockedDecisionCardsForThread([summary], PM_THREAD_ID).map((entry) => entry.taskKey),
  ).toEqual(["BB-3", "BB-7"]);
  expect(dockedDecisionCardsForThread([summary], ThreadId.make("other"))).toEqual([]);
});
