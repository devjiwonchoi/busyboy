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
  const radiosIn = (element: HTMLElement) => [
    ...element.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];

  const failedQuestion =
    "#3 Fix the login redirect: 리드 작업이 실패했어요 (로그인 만료 401)\n\n오류: unexpected status 401 Unauthorized: token_expired\n\n다시 시도하면 리드가 멈춘 곳부터 이어서 해요. 리드에게 전할 말이 있으면 함께 적어 주세요.";
  const failedCard = {
    kind: "blocker" as const,
    options: [...TURN_FAILED_OPTIONS],
    question: failedQuestion,
  };

  it("shows the action, reason, impact and recommendation without expanding context", async () => {
    const open = await openCard({
      context: {
        action: "로그인 수정 변경을 기본 브랜치에 합칩니다.",
        reason: "로그인 후 요청한 페이지로 이동하지 않는 문제를 고칩니다.",
        impacts: ["merge", "cost"],
        cost: "$5 상한",
        reversibility: "requires_work",
        recommendation: "변경 내용을 확인한 뒤 합치기를 추천합니다.",
      },
    });
    const explanation = open.querySelector<HTMLElement>('[data-attention-context="known"]')!;
    expect(explanation.querySelector("details")).toBeNull();
    expect(explanation.querySelector("[data-attention-action]")?.textContent).toBe(
      "로그인 수정 변경을 기본 브랜치에 합칩니다.",
    );
    expect(explanation.querySelector("[data-attention-reason]")?.textContent).toBe(
      "로그인 후 요청한 페이지로 이동하지 않는 문제를 고칩니다.",
    );
    expect(explanation.querySelector("[data-attention-impacts]")?.textContent).toContain(
      "비용: $5 상한",
    );
    expect(explanation.textContent).toContain("배포 없음");
    expect(explanation.textContent).toContain("외부 게시 없음");
    expect(explanation.textContent).toContain("되돌리려면 별도 작업 필요");
    expect(explanation.querySelector("[data-attention-recommendation]")?.textContent).toBe(
      "변경 내용을 확인한 뒤 합치기를 추천합니다.",
    );
    expect(explanation.scrollWidth).toBeLessThanOrEqual(explanation.clientWidth);
    await page.screenshot({ path: `__screenshots__/readable-decision-${width}.png` });
  });

  it("marks missing legacy impact details as unknown rather than safe", async () => {
    const open = await openCard({ context: null });
    const explanation = open.querySelector<HTMLElement>('[data-attention-context="unknown"]')!;
    expect(explanation.textContent).toContain("영향 확인 필요");
    expect(explanation.textContent).toContain("구조화된 이유·영향·추천안 정보가 없습니다");
    expect(explanation.textContent?.includes("추가 비용 없음")).toBe(false);
    expect(explanation.textContent?.includes("되돌리기 가능")).toBe(false);
  });

  it("keeps a long legacy question readable and sends the unabridged Korean option", async () => {
    const question =
      "canary 리포트 Cost 표에 판정을 붙이는 cost calibration이 끝났어요(5개 중 2개 성공, 3개 실패). 행별 τ는 다음과 같아요. Static first visit ±1.0%, Static repeat visit ±2.5%, Navigation without prefetch ±1.0%, Navigation with prefetch ±1.0%, Cache revalidation ±10.2%, Dynamic compute ±26.6%. Dynamic compute는 20%를 넘어서 쓸 수 없어요. 그래서 고칠 때까지 판정이 계속 '회귀 아님'으로 나와요. 저장된 canary.45 결과에 넣어 보니 6행 모두 판정이 붙었고 회귀는 없었어요. 실제 쓴 비용은 cost 실행 5개, Vercel preview 배포 177개, sandbox 약 20시간(2 vCPU)이에요. 많이 잡아도 약 $6로, 상한 $15 안이에요. 실패 원인은 두 가지였어요. (1) 1·2번째 실행: 배포가 준비됐는지 묻는 Vercel API 요청 하나가 30초 넘게 답이 없었는데, 다시 시도하지 않아서 실행 전체가 멈췄어요. NB-15(API 재시도와 backoff)가 이걸 고쳐요. (2) 5번째 실행: 측정을 시작한 뒤 sandbox 하나가 로그 보급을 멈춰서 실패했어요. 이건 NB-15와 별개예요. calibration은 이미 완료돼서, 다음 canary 리포트부터 이 τ가 자동으로 쓰여요. 다시 돌리면 τ가 좋아질지도 확실하지 않아요. τ는 여러 실행에서 가장 크게 흔들린 값으로 정해져서, 실행을 늘리면 τ는 그대로이거나 오히려 커질 수 있어요. 제 추천은 A예요.";
    const option =
      "A (추천): 지금 calibration을 그대로 쓴다. 다시 돌리지 않고, 다음 canary 리포트에서 판정이 붙는지만 확인한다. Dynamic compute 노이즈는 따로 다룬다";
    const options = [
      option,
      "B: NB-15가 머지된 뒤 calibration을 한 번 더 돌려 5개를 모두 성공시킨다 (약 $6~10 추가)",
      "C: 지금 결과를 쓰되, Dynamic compute τ가 왜 큰지 저장된 두 실행으로 먼저 조사한다 (무료, 읽기 전용)",
    ];
    const projectId = ProjectId.make("project-benchmarks");
    server.summary = {
      ...server.summary!,
      projectId,
      taskKeyPrefix: "NB",
      tasks: server.summary!.tasks.map((task) => ({
        ...task,
        number: 13,
        title: "비용 판정 기준 보정",
      })),
      openCount: 1,
      decisionCards: [
        {
          ...card({ projectId, question, options, context: null }),
          taskTitle: "비용 판정 기준 보정",
        },
      ],
    };
    await renderCards();
    const open = cardElement("open")!;
    expect(open.querySelector("[data-decision-card-headline]")?.textContent).toBe(
      "비용 판정 기준 보정에 대한 결정",
    );
    expect(open.querySelector("[data-decision-card-meta]")?.textContent).toBe(
      "Decision · 비용 판정 기준 보정 · next-benchmarks (NB-13)",
    );
    expect(open.querySelector("[data-decision-card-context]")?.textContent).toBe(question);
    const radios = radiosIn(open);
    expect(radios[0]!.querySelector("[data-decision-option-label]")?.textContent).toBe("A");
    expect(radios[0]!.querySelector("[data-decision-option-recommended]")).toBeTruthy();
    expect(radios[0]!.querySelector("[data-decision-option-tradeoff]")?.textContent).toContain(
      "Dynamic compute 노이즈는 따로 다룬다",
    );
    expect(radios).toHaveLength(3);
    const body = open.querySelector<HTMLElement>("[data-decision-card-context]")!;
    expect(getComputedStyle(body.querySelector("p")!).fontWeight).toBe("400");
    expect(open.scrollWidth).toBeLessThanOrEqual(open.clientWidth);
    await page.screenshot({ path: `__screenshots__/readable-legacy-decision-${width}.png` });
    await userEvent.click(await vi.waitFor(() => buttonIn(open, "전체 보기")));
    expect(body.getBoundingClientRect().height).toBeGreaterThan(120);
    expect(body.textContent).toBe(question);
    await page.screenshot({
      path: `__screenshots__/readable-legacy-decision-expanded-${width}.png`,
    });
    await userEvent.click(radios[0]!);
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() => expect(server.answers[0]?.answer).toBe(option));
  });

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

  it("shows a clear question, then relays the explicit pick and note to the lead", async () => {
    const open = await openCard(undefined);
    const header = open.querySelector("[data-decision-card-meta]")?.textContent;
    expect(header).toBe("Decision · Fix the login redirect · BusyBoy (BB-3)");
    await new Promise(requestAnimationFrame);
    expect(open.querySelector("[data-decision-card-context-toggle]")).toBeNull();
    expect(open.querySelector("[data-decision-card-headline]")?.textContent).toBe(
      QUESTION.split("\n")[0],
    );
    expect(open.querySelector("[data-decision-card-context]")?.textContent).toContain("가드에서");
    expect(open.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
      QUESTION.split("\n")[0],
    );
    const radios = radiosIn(open);
    expect(radios).toHaveLength(2);
    expect(radios[0]!.querySelector("[data-decision-option-recommended]")?.textContent).toBe(
      "Recommended",
    );
    expect(radios[1]!.querySelector("[data-decision-option-recommended]")).toBeNull();
    expect(radios[0]!.querySelector("[data-decision-option-tradeoff]")?.textContent).toBe(
      "오늘 배포, 라우터는 다음 태스크",
    );
    expect(open.textContent?.includes("(Recommended)")).toBe(false);
    expect(noteIn(open).getAttribute("aria-label")).toBe("Note for your answer");
    expect((buttonIn(open, "Submit") as HTMLButtonElement).disabled).toBe(true);
    const bounds = open.getBoundingClientRect();
    for (const element of [...radios, noteIn(open), buttonIn(open, "Submit")]) {
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      expect(element.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
    }
    expect(open.scrollWidth).toBeLessThanOrEqual(open.clientWidth);
    await userEvent.click(radios[0]!);
    expect(server.answers).toHaveLength(0);
    await userEvent.type(noteIn(open), "플래그를 유지해 주세요");
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]?.answer).toBe(`${OPTIONS[0]}\nNote: 플래그를 유지해 주세요`);
    expect(server.leadMessages).toEqual([
      `[User answer via BusyBoy] ${QUESTION} → ${OPTIONS[0]}\nNote: 플래그를 유지해 주세요`,
    ]);
    const answered = cardElement("answered")!;
    expect(answered.querySelector("[data-answered-question-id] .font-medium")?.textContent).toBe(
      header,
    );
    expect(answered.querySelector("[data-selected=true]")?.textContent).toContain(OPTIONS[0]);
    expect(answered.querySelector("[data-answered-question-note]")?.textContent).toBe(
      "Note: 플래그를 유지해 주세요",
    );
  });

  it("shows a PM's own blocker with the PM and project names and sends the pick back to the PM", async () => {
    const question =
      "Jota 막힘: 자동 권한 검사가 작업을 거부했어요\n\n거부된 작업: `gh workflow run release.yml --ref main`\n이유: Production Deploy";
    const options = [
      "진행해도 돼요: 내 지시로 다시 시도",
      "내가 직접 실행할게요",
      "이 단계는 빼고 계속",
    ];
    server.summary = {
      ...server.summary!,
      openCount: 1,
      decisionCards: [
        {
          ...card({
            id: ProjectAttentionItemId.make("attention-pm"),
            taskId: null,
            kind: "blocker",
            askerThreadId: PM_THREAD_ID,
            question,
            options,
          }),
          taskNumber: null,
          taskTitle: "Jota",
        },
      ],
    };
    await renderCards();
    const open = cardElement("open")!;
    expect(open.querySelector("[data-decision-card-meta]")?.textContent).toBe(
      "Blocker · Jota · BusyBoy",
    );
    expect(open.querySelector("[data-decision-card-context]")?.textContent).toContain(
      "gh workflow run release.yml --ref main",
    );
    await page.screenshot({ path: `__screenshots__/pm-blocker-card-${width}.png` });
    await userEvent.click(radiosIn(open)[1]!);
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]).toMatchObject({
      attentionItemId: "attention-pm",
      answer: "내가 직접 실행할게요",
    });
    expect(cardElement("answered")).not.toBeNull();
  });

  it("uses a single tab stop and moves both selection and focus with radio keys", async () => {
    const open = await openCard(undefined);
    const radios = radiosIn(open);
    await act(() =>
      (open.querySelector("[data-decision-card-expand]") as HTMLButtonElement).focus(),
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(radios[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radios[0]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(radios[1]);
    await userEvent.keyboard("{Home}{ArrowUp}");
    expect(document.activeElement).toBe(radios[1]);
    expect(server.answers).toHaveLength(0);
  });

  it("submits a pick and note with Enter", async () => {
    const open = await openCard(undefined);
    await userEvent.click(radiosIn(open)[1]!);
    await userEvent.type(noteIn(open), "다음 주까지{Enter}");
    await vi.waitFor(() =>
      expect(server.answers[0]?.answer).toBe(`${OPTIONS[1]}\nNote: 다음 주까지`),
    );
  });

  it("preserves the draft and re-enables controls when sending fails", async () => {
    server.fail = true;
    const open = await openCard(undefined);
    await userEvent.click(radiosIn(open)[0]!);
    await userEvent.type(noteIn(open), "다시 시도");
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() =>
      expect((buttonIn(open, "Submit") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(cardElement("open")).toBe(open);
    expect(radiosIn(open)[0]!.getAttribute("aria-checked")).toBe("true");
    expect(radiosIn(open)[0]!.disabled).toBe(false);
    expect(noteIn(open).disabled).toBe(false);
    expect(noteIn(open).value).toBe("다시 시도");
    server.fail = false;
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() =>
      expect(server.answers[0]?.answer).toBe(`${OPTIONS[0]}\nNote: 다시 시도`),
    );
  });

  it("sends a pick alone unchanged and leaves superseded cards inert", async () => {
    const open = await openCard(undefined);
    await userEvent.click(radiosIn(open)[0]!);
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() => expect(server.answers[0]?.answer).toBe(OPTIONS[0]));
    await act(() =>
      publish({ ...server.summary!, decisionCards: [card({ supersededAt: ASKED_AT })] }),
    );
    expect(cardElement("resolved")?.textContent).toContain("No longer needed");
    expect(cardElement("resolved")?.querySelector("button")).toBeNull();
  });

  it("relays a typed answer without a pick to the lead as written", async () => {
    const open = await openCard(undefined);
    expect(noteIn(open).placeholder).toBe("Write your own answer, or add a note to your pick");
    await userEvent.type(noteIn(open), "   ");
    expect((buttonIn(open, "Submit") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(noteIn(open));
    await userEvent.type(noteIn(open), "우선 원인부터 찾아보자");
    expect(radiosIn(open).some((radio) => radio.getAttribute("aria-checked") === "true")).toBe(
      false,
    );
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]?.answer).toBe("우선 원인부터 찾아보자");
    expect(server.leadMessages).toEqual([
      `[User answer via BusyBoy] ${QUESTION} → 우선 원인부터 찾아보자`,
    ]);
    const answered = cardElement("answered")!;
    expect(answered.querySelector("[data-selected=true]")).toBeNull();
    expect(answered.querySelector("[data-answered-question-text]")?.textContent).toBe(
      "Answer: 우선 원인부터 찾아보자",
    );
  });

  it("sends a typed answer without a pick with Enter", async () => {
    const open = await openCard(undefined);
    await userEvent.type(noteIn(open), "둘 다 아니고 먼저 로그를 봐 주세요{Enter}");
    await vi.waitFor(() =>
      expect(server.answers[0]?.answer).toBe("둘 다 아니고 먼저 로그를 봐 주세요"),
    );
  });

  it("uses the implicit feedback answer for a blocker without options", async () => {
    const open = await openCard({ kind: "blocker", options: [] });
    expect(open.querySelector("[data-decision-card-meta]")?.textContent).toBe(
      "Blocker · Fix the login redirect · BusyBoy (BB-3)",
    );
    expect(open.querySelector('[role="radiogroup"]')).toBeNull();
    expect(noteIn(open).placeholder).toBe("Write your answer");
    expect((buttonIn(open, "Submit") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(noteIn(open), "접근 권한을 열었어요");
    await userEvent.click(buttonIn(open, "Submit"));
    await vi.waitFor(() =>
      expect(server.answers[0]?.answer).toBe("Give feedback\nNote: 접근 권한을 열었어요"),
    );
  });

  it("folds long context and carries the draft into full screen until answered", async () => {
    const context = Array.from({ length: 40 }, (_, index) => `- Context line ${index + 1}`).join(
      "\n",
    );
    const open = await openCard({ question: `로그인 리다이렉트 범위?\n\n${context}` });
    const box = open.querySelector<HTMLElement>("[data-decision-card-context]")!;
    const foldedHeight = box.getBoundingClientRect().height;
    expect(foldedHeight).toBeLessThan(200);
    await userEvent.click(await vi.waitFor(() => buttonIn(open, "전체 보기")));
    expect(box.getBoundingClientRect().height).toBeGreaterThanOrEqual(foldedHeight * 3);
    await userEvent.click(buttonIn(open, "접기"));
    expect(box.getBoundingClientRect().height).toBe(foldedHeight);
    await userEvent.click(radiosIn(open)[1]!);
    await userEvent.type(noteIn(open), "단계를 나눠 주세요");
    await userEvent.click(
      open.querySelector<HTMLButtonElement>('[data-decision-card-expand="inline"]')!,
    );
    const expanded = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-decision-card-expanded]");
      expect(element).toBeTruthy();
      return element!;
    });
    expect(expanded.textContent).toContain("Context line 40");
    expect(expanded.querySelector("[data-decision-card-context-toggle]")).toBeNull();
    expect(radiosIn(expanded)[1]!.getAttribute("aria-checked")).toBe("true");
    expect(noteIn(expanded).value).toBe("단계를 나눠 주세요");
    await userEvent.click(buttonIn(expanded, "Submit"));
    await vi.waitFor(() =>
      expect(server.answers[0]?.answer).toBe(`${OPTIONS[1]}\nNote: 단계를 나눠 주세요`),
    );
    await vi.waitFor(() => expect(cardElement("answered")).toBeTruthy());
    await vi.waitFor(() =>
      expect(document.querySelector("[data-decision-card-expanded]")).toBeNull(),
    );
  });
});
