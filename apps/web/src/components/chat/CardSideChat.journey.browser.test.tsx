import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  emptyProjectTaskSpec,
  EnvironmentId,
  formatLeadQuestion,
  newProjectTaskTodo,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTaskReference,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAskLeadInput,
  type ProjectTeamTaskDetail,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import type { LeadThreadMessage } from "./CardSideChat.logic";
import { DecisionCard } from "./DecisionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const TASK_ID = ProjectTaskId.make("task-32");
const LEAD_THREAD_ID = ThreadId.make("lead-32");
const AT = "2026-11-05T03:00:00.000Z";

/** The server: the open card, the lead thread's messages and what the user sent. */
const server = vi.hoisted(() => ({
  card: null as ProjectDecisionCard | null,
  detail: null as ProjectTeamTaskDetail | null,
  managers: [] as Array<{ environmentId: string; summary: unknown }>,
  leadMessages: [] as LeadThreadMessage[],
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
  questions: [] as ProjectTeamAskLeadInput[],
}));

function emit() {
  for (const listener of server.listeners) listener();
}

function subscribe(listener: () => void) {
  server.listeners.add(listener);
  return () => server.listeners.delete(listener);
}

/** The lead thread gets a message, as the thread stream would deliver it. */
function leadSays(message: LeadThreadMessage) {
  server.leadMessages = [
    ...server.leadMessages.filter((entry) => entry.id !== message.id),
    message,
  ];
  emit();
}

/** Mirrors ProjectTeamService.askLead: the question lands in the lead thread; the card stays. */
async function askLead(input: ProjectTeamAskLeadInput) {
  server.questions.push(input);
  const messageId = `ask-${server.questions.length}`;
  leadSays({
    id: messageId,
    role: "user",
    text: formatLeadQuestion({
      cardId: input.attentionItemId,
      cardLabel: "플랜 승인 · BU-32 Plan approval modal",
      question: input.question,
      quotes: input.quotes,
    }),
    streaming: false,
  });
  return AsyncResult.success({ messageId });
}

/** Mirrors AttentionRouter.answer: the stream then shows the card answered. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  const card = server.card!;
  server.card = {
    ...card,
    item: { ...card.item, answer: input.answer, answeredAt: AT, answeredBy: "user" },
  };
  emit();
  return AsyncResult.success({ item: card.item });
}

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useTaskDetail: (() => ({
    data: server.detail,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => undefined,
  })) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
  useAskLead: (() => (_environmentId: unknown, input: ProjectTeamAskLeadInput) =>
    askLead(input)) as never,
  useProjectManagerEntries: (() => server.managers) as never,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: ((ref: { threadId: string } | null) => {
    const messages = useSyncExternalStore(subscribe, () => server.leadMessages);
    return ref?.threadId === LEAD_THREAD_ID
      ? { environmentId: ENVIRONMENT_ID, projection: { messages } }
      : null;
  }) as never,
  useProjects: (() => [
    { environmentId: ENVIRONMENT_ID, id: PROJECT_ID, title: "BusyBoy" },
  ]) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => [ENVIRONMENT_ID]) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ params, to: _to, ...rest }: { params?: { taskId?: string }; to?: string }) => (
    <a href={`#${params?.taskId ?? ""}`} {...rest} />
  )) as never,
}));

function taskRef(id: string, number: number, title: string): ProjectTaskReference {
  return {
    id: ProjectTaskId.make(id),
    number,
    parentTaskId: null,
    waitsOn: [],
    title,
    stage: "awaiting_approval",
    leadThreadId: LEAD_THREAD_ID,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: AT,
  };
}

function makeManagers() {
  return [
    {
      environmentId: ENVIRONMENT_ID,
      summary: makeProjectManagerSummaryFixture({
        projectId: PROJECT_ID,
        taskKeyPrefix: "BU",
        tasks: [taskRef("task-32", 32, "Plan approval modal")],
      }),
    },
  ];
}

function makeDetail(): ProjectTeamTaskDetail {
  return {
    task: { id: TASK_ID, projectId: PROJECT_ID, number: 32, stage: "awaiting_approval" },
    key: "BU-32",
    versions: [
      {
        taskId: TASK_ID,
        version: 1,
        spec: {
          ...emptyProjectTaskSpec(),
          goal: "Keep the cursor position steady after review.",
          nonGoals: "Changing how tasks are created.",
          todos: [newProjectTaskTodo("t1", "Add the card")],
        },
        author: "agent",
        authorThreadId: LEAD_THREAD_ID,
        note: "Plan v1",
        createdAt: AT,
      },
    ],
    sessions: [],
    children: [],
    openAttention: [],
  } as unknown as ProjectTeamTaskDetail;
}

function makeCard(kind: "approval" | "decision"): ProjectDecisionCard {
  return {
    taskNumber: 32,
    taskTitle: "Plan approval modal",
    proposal: null,
    plan: null,
    item: {
      id: ProjectAttentionItemId.make(`attention-${kind}`),
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      kind,
      question:
        kind === "approval"
          ? "Plan ready: a card that opens a review modal."
          : "어느 쪽으로 갈까요?\n\n두 방법 모두 가능해요.",
      options: kind === "approval" ? [] : ["가드만 먼저 (Recommended)", "라우터 전체"],
      answer: null,
      answeredAt: null,
      askerThreadId: LEAD_THREAD_ID,
      batchId: ProjectAttentionBatchId.make("batch-1"),
      createdAt: AT,
      supersededAt: null,
      answeredBy: null,
      specVersion: kind === "approval" ? 1 : null,
      summary: kind === "approval" ? "- A card that opens a review modal" : null,
      verification: null,
    },
  };
}

function LiveCard() {
  const card = useSyncExternalStore(subscribe, () => server.card);
  if (card === null) return null;
  return card.item.kind === "approval" ? (
    <PlanApprovalCard card={card} environmentId={ENVIRONMENT_ID} />
  ) : (
    <DecisionCard
      card={card}
      environmentId={ENVIRONMENT_ID}
      threadRef={scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("pm-thread"))}
      cwd={undefined}
    />
  );
}

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const visible = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && element.offsetParent !== null;

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === name && visible(element),
  );
  if (match === undefined) throw new Error(`No visible "${name}" button`);
  return match;
}

function sideChat(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-card-side-chat]");
  if (!visible(element)) throw new Error("Side chat not visible");
  return element;
}

async function ask(question: string) {
  const input = sideChat().querySelector<HTMLTextAreaElement>("[data-card-side-chat-input]")!;
  await userEvent.type(input, question);
  await userEvent.click(button("보내기", sideChat()));
}

describe.each([
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
])("card side chat on $name", ({ name, width, height }) => {
  const mobile = width < 768;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, height);
    server.detail = makeDetail();
    server.managers = makeManagers();
    server.leadMessages = [
      { id: "m0", role: "user", text: "Start the task.", streaming: false },
      { id: "m1", role: "assistant", text: "Writing the plan.", streaming: false },
    ];
    server.answers = [];
    server.questions = [];
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  it("asks the lead about a quoted plan passage, then approves in the same view", async () => {
    server.card = makeCard("approval");
    await act(async () => root.render(<LiveCard />));
    await userEvent.click(button("Review plan"));
    const endResult = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-plan-section="End result"]');
      if (element === null) throw new Error("Plan not open");
      return element;
    });

    if (mobile) {
      // Phones show one half at a time: the card first, the chat one tab away.
      expect(document.querySelector("[data-card-side-chat]")?.closest(".hidden")).not.toBeNull();
      expect(button("카드").getAttribute("aria-selected")).toBe("true");
    } else {
      // Side by side: the chat sits to the right of the plan.
      const plan = endResult.getBoundingClientRect();
      expect(sideChat().getBoundingClientRect().left).toBeGreaterThanOrEqual(plan.right);
    }

    // Quote a plan passage into the question.
    await userEvent.tripleClick(endResult);
    await userEvent.click(await vi.waitFor(() => button("질문에 인용")));
    const chat = await vi.waitFor(() => sideChat());
    expect(chat.querySelector("h2")?.textContent).toBe("리드에게 질문");
    expect(chat.querySelector("[data-card-side-chat-context]")?.textContent).toBe(
      "BusyBoy · BU-32 Plan approval modal",
    );
    expect(chat.querySelector("[data-card-side-chat-quote]")?.textContent).toContain(
      "Keep the cursor position steady after review.",
    );
    // The lead's other work stays out of the side chat.
    expect(chat.textContent).not.toContain("Writing the plan.");

    await ask("왜 커서 위치예요?");
    expect(server.questions).toEqual([
      {
        projectId: PROJECT_ID,
        attentionItemId: makeCard("approval").item.id,
        question: "왜 커서 위치예요?",
        quotes: [{ section: "End result", quote: "Keep the cursor position steady after review." }],
      },
    ]);
    await vi.waitFor(() => {
      expect(chat.querySelector("[data-card-side-chat-question]")?.textContent).toContain(
        "왜 커서 위치예요?",
      );
      expect(chat.querySelector("[data-card-side-chat-quote]")).toBeNull();
      expect(chat.textContent).toContain("답을 기다리는 중");
    });

    // The lead's reply streams in.
    const cardLine = `<!-- card:${makeCard("approval").item.id} -->`;
    leadSays({
      id: "a1",
      role: "assistant",
      text: `[답변]\n${cardLine}\n스크롤보다 커서가`,
      streaming: true,
    });
    await vi.waitFor(() => {
      expect(chat.querySelector("[data-card-side-chat-answer]")?.textContent).toContain(
        "스크롤보다 커서가",
      );
      expect(chat.textContent).toContain("리드가 답하는 중");
    });
    leadSays({
      id: "a1",
      role: "assistant",
      text: `[답변]\n${cardLine}\n스크롤보다 커서가 더 자주 튀어요. 변경 요청으로 보낼까요?`,
      streaming: false,
    });
    // The lead goes back to its work; that stays out of the side chat.
    leadSays({ id: "w1", role: "assistant", text: "Back to the plan.", streaming: false });
    await vi.waitFor(() =>
      expect(chat.querySelector("[data-card-side-chat-answer]")?.textContent).toContain(
        "변경 요청으로 보낼까요?",
      ),
    );
    expect(chat.textContent).not.toContain("Back to the plan.");
    expect(chat.textContent).not.toContain("[답변]");
    expect(chat.textContent).not.toContain("card:");
    await page.screenshot({ path: `__screenshots__/card-side-chat-plan-${name}.png` });

    // Asking left the card open and unanswered.
    expect(document.querySelector("[data-plan-review]")).not.toBeNull();
    expect(server.answers).toEqual([]);
    expect(server.card?.item.answeredAt).toBeNull();

    // Approve right here.
    const review = document.querySelector<HTMLElement>("[data-plan-review]")!;
    if (mobile) await userEvent.click(button("카드", review));
    await userEvent.click(button("Approve", review));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]?.attentionItemId).toBe(makeCard("approval").item.id);
  });

  it("opens the side chat beside a full-screen decision card", async () => {
    server.card = makeCard("decision");
    await act(async () => root.render(<LiveCard />));
    await userEvent.click(
      document.querySelector<HTMLButtonElement>('[aria-label="Open full screen"]')!,
    );
    const expanded = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-decision-card-expanded]");
      if (element === null) throw new Error("Not expanded");
      return element;
    });
    if (mobile) await userEvent.click(button("리드에게 질문", expanded));
    const chat = await vi.waitFor(() => sideChat());
    expect(expanded.contains(chat)).toBe(true);
    expect(chat.querySelector("[data-card-side-chat-context]")?.textContent).toBe(
      "BusyBoy · BU-32 Plan approval modal",
    );

    await ask("라우터 전체면 얼마나 걸려요?");
    expect(server.questions.at(-1)?.question).toBe("라우터 전체면 얼마나 걸려요?");
    leadSays({ id: "a2", role: "assistant", text: "[답변] 2-3일이요.", streaming: false });
    await vi.waitFor(() => expect(chat.textContent).toContain("2-3일이요."));
    await page.screenshot({ path: `__screenshots__/card-side-chat-decision-${name}.png` });

    // Still open: pick and submit in the same view.
    expect(server.answers).toEqual([]);
    if (mobile) await userEvent.click(button("카드", expanded));
    await userEvent.click(
      [...expanded.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(visible)!,
    );
    await userEvent.click(button("Submit", expanded));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
  });
});
