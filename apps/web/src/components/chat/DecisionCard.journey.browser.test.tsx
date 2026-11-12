import {
  TURN_FAILED_OPTIONS,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAttentionSummary,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { useProjectManagerEntries } from "../../state/projectTeam";
import { DecisionCard } from "./DecisionCard";

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: "project-1", environmentId: "environment-local", title: "BusyBoy" },
    { id: "project-benchmarks", environmentId: "environment-local", title: "next-benchmarks" },
  ]) as never,
}));

const PROJECT_ID = ProjectId.make("project-1");
const PM_THREAD_ID = ThreadId.make("pm-thread");
const LEAD_THREAD_ID = ThreadId.make("lead-thread");
const QUESTION =
  "로그인 리다이렉트 수정을 어디까지 할까요?\n\n- 가드에서 리다이렉트를 처리합니다.\n- 라우터 변경 범위를 결정해 주세요.";
const OPTIONS = [
  "가드만 먼저 — 오늘 배포, 라우터는 다음 태스크 (Recommended)",
  "라우터 전체 — 한 번에 끝나지만 2-3일 걸림",
];
const ASKED_AT = "2026-11-05T03:00:00.000Z";

/** The server side of the journey: the team's questions and the task lead's inbox. */
const server = vi.hoisted(() => ({
  summary: null as ProjectTeamAttentionSummary | null,
  listeners: new Set<() => void>(),
  leadMessages: [] as string[],
  answers: [] as ProjectTeamAnswerDecisionInput[],
  fail: false,
}));

function publish(summary: ProjectTeamAttentionSummary) {
  server.summary = summary;
  for (const listener of server.listeners) listener();
}

/** Mirrors AttentionRouter.answer: relay to the lead, then the stream shows the card answered. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  if (server.fail) {
    return AsyncResult.fail(new Error("Decision send failed"));
  }
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
    plan: null,
    item: {
      id: ProjectAttentionItemId.make("attention-plan"),
      projectId: PROJECT_ID,
      taskId: ProjectTaskId.make("task-3"),
      kind: "decision",
      question: QUESTION,
      options: OPTIONS,
      answer: null,
      answeredAt: null,
      askerThreadId: LEAD_THREAD_ID,
      batchId: ProjectAttentionBatchId.make("batch-1"),
      createdAt: ASKED_AT,
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
      details: null,
      senderRole: null,
      senderName: null,
      ...overrides,
    },
  };
}

/** The team's cards as the task page shows them, answered through the PM's thread. */
function TeamCards() {
  return useProjectManagerEntries([]).flatMap(({ environmentId, summary }) =>
    summary.decisionCards.map((entry) => (
      <DecisionCard
        key={entry.item.id}
        card={entry}
        environmentId={environmentId}
        threadRef={scopeThreadRef(environmentId, summary.pmThreadId)}
        cwd={undefined}
      />
    )),
  );
}

function renderCards() {
  return act(async () => root.render(<TeamCards />));
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.summary = makeProjectManagerSummaryFixture({
    pmThreadId: PM_THREAD_ID,
    taskKeyPrefix: "BB",
    tasks: [
      {
        id: ProjectTaskId.make("task-3"),
        number: 3,
        parentTaskId: null,
        waitsOn: [],
        title: "Fix the login redirect",
        stage: "running",
        leadThreadId: LEAD_THREAD_ID,
        prUrl: null,
        lastOutcome: null,
        openQuestion: true,
        openBlocker: false,
        iterateRound: 0,
        shipRound: 0,
        modelSteps: {},
        updatedAt: ASKED_AT,
      },
    ],
  });
  server.leadMessages = [];
  server.answers = [];
  server.fail = false;
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function cardElement(state: "open" | "answered" | "resolved") {
  return container.querySelector<HTMLElement>(`[data-decision-card-state="${state}"]`);
}

function buttonIn(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

describe.each([
  { name: "desktop", width: 900, height: 900 },
  { name: "phone", width: 390, height: 844 },
])("decision journey on $name", ({ width, height }) => {
  beforeEach(async () => {
    await page.viewport(width, height);
    container.style.width = `${width}px`;
  });

  async function openCard(overrides: Partial<ProjectDecisionCard["item"]> | undefined) {
    server.summary = { ...server.summary!, openCount: 1, decisionCards: [card(overrides)] };
    await renderCards();
    return cardElement("open")!;
  }

  const noteIn = (element: HTMLElement) =>
    element.querySelector<HTMLTextAreaElement>("[data-decision-card-note]")!;

  const failedQuestion =
    "#3 Fix the login redirect: 리드 작업이 실패했어요 (로그인 만료 401)\n\n오류: unexpected status 401 Unauthorized: token_expired\n\n다시 시도하면 리드가 멈춘 곳부터 이어서 해요. 리드에게 전할 말이 있으면 함께 적어 주세요.";
  const failedCard = {
    kind: "blocker" as const,
    options: [...TURN_FAILED_OPTIONS],
    question: failedQuestion,
  };

  it.each([
    { note: "", cancel: false, enter: false, expected: "다시 시도" },
    { note: "테스트부터", cancel: false, enter: true, expected: "다시 시도\nNote: 테스트부터" },
    { note: "무시할 메모", cancel: true, enter: false, expected: "태스크 취소" },
  ])("answers failed turns with $expected", async ({ note, cancel, enter, expected }) => {
    const open = await openCard(failedCard);
    expect(open.dataset.decisionCardVariant).toBe("turn-failed");
    expect(open.querySelector("[data-decision-card-headline]")?.textContent).toBe(
      failedQuestion.split("\n")[0]!,
    );
    expect(open.querySelector('[role="radiogroup"]')).toBeNull();
    expect(noteIn(open).getAttribute("aria-label")).toBe("리드에게 전할 말");
    const retry = buttonIn(open, "다시 시도");
    const cancelButton = buttonIn(open, "태스크 취소");
    const bounds = open.getBoundingClientRect();
    for (const element of [retry, cancelButton, noteIn(open)]) {
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      expect(element.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
    }
    if (note) {
      await userEvent.type(noteIn(open), note);
    }
    if (enter) {
      await userEvent.keyboard("{Enter}");
    } else {
      await userEvent.click(cancel ? cancelButton : retry);
    }
    await vi.waitFor(() =>
      expect(server.answers.map((answer) => answer.answer)).toEqual([expected]),
    );
    expect(cardElement("answered")).toBeTruthy();
  });

  it("preserves a failed retry's note and shares the variant in full screen", async () => {
    const open = await openCard(failedCard);
    server.fail = true;
    await userEvent.type(noteIn(open), "테스트부터");
    await userEvent.click(buttonIn(open, "다시 시도"));
    await vi.waitFor(() =>
      expect((buttonIn(open, "다시 시도") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(noteIn(open).value).toBe("테스트부터");
    expect((buttonIn(open, "태스크 취소") as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(open.querySelector<HTMLButtonElement>("[data-decision-card-expand]")!);
    const expanded = document.querySelector<HTMLElement>("[data-decision-card-expanded]")!;
    expect(expanded.dataset.decisionCardVariant).toBe("turn-failed");
    expect(expanded.querySelector('[role="radiogroup"]')).toBeNull();
    expect(noteIn(expanded).value).toBe("테스트부터");
    server.fail = false;
    await userEvent.click(buttonIn(expanded, "다시 시도"));
    await vi.waitFor(() => expect(server.answers[0]?.answer).toBe("다시 시도\nNote: 테스트부터"));
  });

  it("retains a failed alternative answer and relays its note on retry", async () => {
    const open = await openCard(undefined);
    await userEvent.click(buttonIn(open, "자세히 보기"));
    const radios = open.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await userEvent.click(radios[1]!);
    await userEvent.type(noteIn(open), "다시 시도");
    server.fail = true;
    await userEvent.click(buttonIn(open, "보내기"));
    await vi.waitFor(() =>
      expect(open.querySelector('[role="alert"]')?.textContent).toContain("보내지 못했어요"),
    );
    expect(radios[1]?.checked).toBe(true);
    expect(noteIn(open).value).toBe("다시 시도");
    server.fail = false;
    await userEvent.click(buttonIn(open, "보내기"));
    await vi.waitFor(() =>
      expect(server.answers[0]?.answer).toBe(`${OPTIONS[1]}\nNote: 다시 시도`),
    );
  });

  it("uses the PM sender for a legacy blocker without a lead and sends the done answer", async () => {
    const open = await openCard({ taskId: null, kind: "blocker", options: [] });
    expect(open.querySelector("[data-decision-card-meta]")?.textContent).toBe("BusyBoy · PM");
    expect(open.textContent?.includes("BB-3")).toBe(false);
    await userEvent.click(buttonIn(open, "처리했어요"));
    await vi.waitFor(() => expect(server.answers[0]?.answer).toBe("처리했어요"));
    expect(cardElement("answered")?.textContent).toContain("BusyBoy · PM");
  });

  it("keeps superseded cards inert and prefixes their compact line with the sender", async () => {
    await openCard({ supersededAt: ASKED_AT });
    expect(cardElement("resolved")?.textContent).toContain("BusyBoy · Fix the login 리드");
    expect(cardElement("resolved")?.textContent?.includes("BB-3")).toBe(false);
    expect(cardElement("resolved")?.querySelector("button")).toBeNull();
  });
});
