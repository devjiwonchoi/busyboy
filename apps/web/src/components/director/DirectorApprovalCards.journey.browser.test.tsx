import {
  EnvironmentId,
  MessageId,
  PLAN_APPROVAL_START,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTaskReference,
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
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { decisionCardsForThread } from "../../state/projectTeam.logic";
import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { MessagesTimeline } from "../chat/MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const DIRECTOR_PROJECT_ID = ProjectId.make("director-project");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const DIRECTOR_THREAD_ID = ThreadId.make("director-thread");
const AT = "2026-11-11T03:00:00.000Z";

/** The server side: the PM's and the Director's summaries, and the answers sent to the leads. */
const server = vi.hoisted(() => ({
  summaries: [] as ProjectTeamAttentionSummary[],
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
}));

function publish(summaries: ProjectTeamAttentionSummary[]) {
  server.summaries = summaries;
  for (const listener of server.listeners) listener();
}

function useServerSummaries() {
  return useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.summaries,
  );
}

/** Mirrors ProjectTeamService.answerDecision: one card, answered once, wherever it was clicked. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  publish(
    server.summaries.map((summary) =>
      summary.projectId !== input.projectId
        ? summary
        : {
            ...summary,
            decisionCards: summary.decisionCards.map((entry) =>
              entry.item.id === input.attentionItemId
                ? {
                    ...entry,
                    item: {
                      ...entry.item,
                      answer: input.answer,
                      answeredAt: AT,
                      answeredBy: "user" as const,
                    },
                  }
                : entry,
            ),
          },
    ),
  );
  return AsyncResult.success({ item: null });
}

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: ((ref: { threadId: string } | null) => {
    const summaries = useServerSummaries();
    return summaries.find((summary) => summary.pmThreadId === ref?.threadId) ?? null;
  }) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
  useProjectManagerEntries: (() =>
    useServerSummaries().map((summary) => ({
      environmentId: ENVIRONMENT_ID,
      summary,
    }))) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => [ENVIRONMENT_ID]) as never,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: "project-1", environmentId: "environment-local", title: "BusyBoy" },
    { id: "director-project", environmentId: "environment-local", title: "Director" },
  ]) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ params, to: _to, ...rest }: { params?: { taskId?: string }; to?: string }) => (
    <a href={`#${params?.taskId ?? ""}`} {...rest} />
  )) as never,
}));

function taskRef(number: number, title: string): ProjectTaskReference {
  return {
    id: ProjectTaskId.make(`task-${number}`),
    number,
    parentTaskId: null,
    waitsOn: [],
    title,
    stage: "awaiting_approval",
    leadThreadId: ThreadId.make(`lead-${number}`),
    prUrl: null,
    lastOutcome: null,
    openQuestion: true,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: AT,
  };
}

function card(
  id: string,
  taskNumber: number,
  title: string,
  kind: "approval" | "blocker",
  at: string,
): ProjectDecisionCard {
  return {
    taskNumber,
    taskTitle: title,
    plan: null,
    item: {
      id: ProjectAttentionItemId.make(id),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make(`task-${taskNumber}`),
      kind,
      question: kind === "approval" ? `${title} 플랜을 승인해 주세요` : `${title} 작업이 멈췄어요`,
      options: kind === "approval" ? [PLAN_APPROVAL_START] : ["다시 시도"],
      answer: null,
      answeredAt: null,
      askerThreadId: ThreadId.make(`lead-${taskNumber}`),
      batchId: ProjectAttentionBatchId.make(`batch-${id}`),
      createdAt: at,
      supersededAt: null,
      answeredBy: null,
      specVersion: kind === "approval" ? 2 : null,
      summary: kind === "approval" ? "목표마다 진행 막대가 보여요." : null,
      verification: null,
      details: null,
      senderRole: "lead",
      senderName: title,
    },
  };
}

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const minute = (index: number) => new Date(Date.UTC(2026, 10, 11, 1, index)).toISOString();

function message(thread: string, index: number, text: string): Entry {
  const createdAt = minute(index);
  return {
    id: `entry-${thread}-${index}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(`${thread}-${index}`),
      role: index % 2 === 0 ? "user" : "assistant",
      text,
      runId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

const DIRECTOR_ENTRIES = [
  message("director", 0, "오늘 뭐 남았어?"),
  message("director", 1, "busyboy 플랜 두 개가 승인을 기다려요."),
];
const PM_ENTRIES = [
  message("pm", 0, "목표 그래프 시작해 줘"),
  message("pm", 1, "리드가 플랜을 쓰고 있어요."),
];

const goalPlan = card("attention-goal", 3, "목표 그래프", "approval", minute(2));
const cachePlan = card("attention-cache", 4, "페이지 캐시", "approval", minute(3));
const loginBlocker = card("attention-login", 5, "로그인", "blocker", minute(4));

const timelineProps = (
  threadId: ThreadId,
  listRef: React.RefObject<LegendListRef | null>,
): Omit<TimelineProps, "timelineEntries"> => ({
  isWorking: false,
  activeTurnInProgress: false,
  listRef,
  latestRun: null,
  turnDiffSummaries: [],
  runs: [],
  routeThreadKey: `environment-local:${threadId}`,
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
});

const directorListRef = createRef<LegendListRef | null>();
const pmListRef = createRef<LegendListRef | null>();

/** The Director chat and the project's PM chat, side by side, fed by the same server. */
function BothChats() {
  const summaries = useServerSummaries();
  return (
    <div className="flex min-h-0 flex-1">
      <div data-chat="director" className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline
          {...timelineProps(DIRECTOR_THREAD_ID, directorListRef)}
          timelineEntries={DIRECTOR_ENTRIES}
          decisionCards={decisionCardsForThread(summaries, DIRECTOR_THREAD_ID)}
        />
      </div>
      <div data-chat="pm" className="flex min-h-0 flex-1 flex-col">
        <MessagesTimeline
          {...timelineProps(PM_THREAD_ID, pmListRef)}
          timelineEntries={PM_ENTRIES}
          decisionCards={decisionCardsForThread(summaries, PM_THREAD_ID)}
        />
      </div>
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(1400, 900);
  server.summaries = [
    {
      ...makeProjectManagerSummaryFixture({
        projectId: PROJECT_ID,
        pmThreadId: PM_THREAD_ID,
        taskKeyPrefix: "BU",
        tasks: [taskRef(3, "목표 그래프"), taskRef(4, "페이지 캐시"), taskRef(5, "로그인")],
      }),
      kind: "pm",
      openCount: 3,
      decisionCards: [goalPlan, cachePlan, loginBlocker],
    },
    {
      ...makeProjectManagerSummaryFixture({
        projectId: DIRECTOR_PROJECT_ID,
        pmThreadId: DIRECTOR_THREAD_ID,
        taskKeyPrefix: "DIR",
      }),
      kind: "director",
    },
  ];
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

const cardIn = (chat: "director" | "pm", id: string) =>
  container.querySelector<HTMLElement>(`[data-chat="${chat}"] [data-decision-card="${id}"]`);

async function findCard(chat: "director" | "pm", id: string) {
  return vi.waitFor(() => {
    const element = cardIn(chat, id);
    expect(element, `${chat} card ${id}`).not.toBeNull();
    return element!;
  });
}

function buttonIn(element: HTMLElement, name: string): HTMLButtonElement {
  const match = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}

it("shows a lead's plan approval in the Director chat and answers it once for both chats", async () => {
  await act(async () => root.render(<BothChats />));

  // The same card shows in both chats, with who sent it.
  const inDirector = await findCard("director", "attention-goal");
  const inPm = await findCard("pm", "attention-goal");
  expect(inDirector.dataset.decisionCardState).toBe("open");
  expect(inPm.dataset.decisionCardState).toBe("open");
  expect(inDirector.querySelector("[data-decision-card-meta]")?.textContent).toBe(
    "BusyBoy · 목표 그래프 리드",
  );
  expect(
    [...inDirector.querySelectorAll("[data-request-bubble] button")].map((b) => b.textContent),
  ).toEqual(["승인", "자세히 보기"]);
  // Only plan approvals join the Director chat; the blocker stays in the PM chat.
  await findCard("pm", "attention-login");
  expect(cardIn("director", "attention-login")).toBeNull();
  await page.screenshot({ path: "__screenshots__/director-approval-cards.png" });

  // Approving in the Director chat answers the one card, and the PM chat shows it answered.
  await userEvent.click(buttonIn(inDirector, "승인"));
  await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  expect(server.answers[0]).toEqual({
    projectId: PROJECT_ID,
    attentionItemId: "attention-goal",
    answer: PLAN_APPROVAL_START,
  });
  await vi.waitFor(() => {
    expect(cardIn("director", "attention-goal")?.dataset.decisionCardState).toBe("answered");
    expect(cardIn("pm", "attention-goal")?.dataset.decisionCardState).toBe("answered");
  });

  // The other way round: approving in the PM chat closes the Director's copy.
  await userEvent.click(buttonIn(await findCard("pm", "attention-cache"), "승인"));
  await vi.waitFor(() => expect(server.answers).toHaveLength(2));
  expect(server.answers[1]!.attentionItemId).toBe("attention-cache");
  await vi.waitFor(() => {
    expect(cardIn("pm", "attention-cache")?.dataset.decisionCardState).toBe("answered");
    expect(cardIn("director", "attention-cache")?.dataset.decisionCardState).toBe("answered");
  });
  // Each card was answered exactly once.
  expect(server.answers.map((answer) => answer.attentionItemId)).toEqual([
    "attention-goal",
    "attention-cache",
  ]);
  await page.screenshot({ path: "__screenshots__/director-approval-cards-answered.png" });
});
