import {
  emptyProjectTaskSpec,
  EnvironmentId,
  newProjectTaskTodo,
  TURN_FAILED_OPTIONS,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAttentionSummary,
  type ProjectTeamTaskDetail,
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
import { useComposerDraftStore } from "../../composerDraftStore";
import { formatRequestLink } from "@t3tools/shared/requestMessage";
import ChatMarkdown from "../ChatMarkdown";

const navigate = vi.hoisted(() => vi.fn());
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => navigate,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: "project-1", environmentId: "environment-local", title: "busyboy" },
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
  detail: undefined as ProjectTeamTaskDetail | undefined,
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
  useTaskDetail: (() => ({ data: server.detail, isPending: false, error: null })) as never,
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
      senderRole: "lead",
      senderName: "목표 그래프",
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
  server.detail = undefined;
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

const PLAN_QUESTION =
  "목표 그래프 플랜 승인 부탁드려요.\n\n격자를 별자리 모양으로 바꾸고, 목표별 정보는 옆 패널로 옮길게요. 지금은 이름이 잘리고 폰에선 점만 보여서요.\n\n같은 데이터면 늘 같은 모양으로 뜨고, 태스크 150개에서도 안 버벅이고, 웹이랑 모바일 둘 다 되면 끝이에요. 비용은 $6~9 정도고 되돌리기 쉬워요.";
const RELEASE =
  "v0.0.20 릴리스 해도 될까요?\n\n1. main 최신 확인\n2. 릴리스 워크플로 실행\n3. 세 플랫폼 빌드 확인\n4. 릴리스 노트 게시";
const ref = scopeThreadRef("environment-local" as never, PM_THREAD_ID);

async function open(entry: ProjectDecisionCard) {
  server.summary = { ...server.summary!, openCount: 1, decisionCards: [entry] };
  await renderCards();
  return cardElement("open")!;
}

for (const width of [1000, 390]) {
  describe(`request messenger at ${width}px`, () => {
    beforeEach(async () => {
      await page.viewport(width, 1000);
      container.style.width = `${width}px`;
    });

    it("shows the sender, paragraphs and todo titles only, then approves and starts", async () => {
      const entry = {
        ...card({ kind: "approval", question: PLAN_QUESTION }),
        plan: {
          summary: "Legacy fallback",
          subtasks: [],
          todos: [
            {
              id: "t1",
              text: "별자리 배치",
              done: true,
              doneWhen: "같은 데이터는 같은 모양",
              dependsOn: [],
            },
            {
              id: "t2",
              text: "목표 패널",
              done: false,
              doneWhen: "모바일에서 이름이 보여요",
              dependsOn: ["t1"],
            },
          ],
        },
      };
      const element = await open(entry);
      expect(element.querySelector("[data-decision-card-meta]")?.textContent).toBe(
        "busyboy · 목표 그래프 리드",
      );
      expect(element.querySelector("h3")?.textContent).toBe("목표 그래프 플랜 승인 부탁드려요.");
      expect(element.textContent).toContain("비용은 $6~9 정도고 되돌리기 쉬워요.");
      const bubble = element.querySelector<HTMLElement>("[data-request-bubble]")!;
      expect([...bubble.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "별자리 배치",
        "목표 패널",
      ]);
      expect(bubble.querySelector("li")?.classList.contains("line-through")).toBe(true);
      expect(bubble.textContent?.includes("모바일에서 이름이 보여요")).toBe(false);
      expect([...bubble.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "승인",
        "자세히 보기",
      ]);
      expect(element.textContent?.includes("BB-3")).toBe(false);
      await page.screenshot({ path: `__screenshots__/request-message-plan-${width}.png` });
      await userEvent.click(buttonIn(element, "자세히 보기"));
      expect(element.querySelector("[data-request-details]")?.textContent).toContain(
        "모바일에서 이름이 보여요",
      );
      expect(element.querySelector("[data-request-details]")?.textContent).toContain("1 다음");
      await userEvent.click(buttonIn(element, "승인"));
      await vi.waitFor(() => expect(server.answers[0]?.answer).toBe("Approve and start"));
    });

    it("keeps the plan bubble short and shows the plan gates and checker verdicts under 자세히 보기", async () => {
      const spec = {
        ...emptyProjectTaskSpec(),
        nonGoals: "격자 색 변경",
        todos: [
          { ...newProjectTaskTodo("t1", "별자리 배치"), doneWhen: "같은 데이터는 같은 모양" },
        ],
        problem: "목표 이름이 잘려서 찾기 어려워요.",
        currentState: "GoalGraph.tsx가 격자로 그려요.",
        risks: "150개에서 느려질 수 있어요.",
      };
      server.detail = {
        task: {
          planCheck: {
            specVersion: 2,
            round: 2,
            status: "failed",
            verdicts: [
              { gate: "problem", pass: true, reason: "현재와 목표가 분명해요." },
              { gate: "risks", pass: false, reason: "위험이 할 일과 이어지지 않아요." },
            ],
            checker: {
              providerInstanceId: "claude",
              model: "claude-opus-4-7",
              threadId: ThreadId.make("checker"),
            },
            startedAt: ASKED_AT,
            checkedAt: ASKED_AT,
            ask: { question: PLAN_QUESTION, context: {} },
          },
        },
        versions: [{ version: 2, spec }],
      } as unknown as ProjectTeamTaskDetail;
      const element = await open(
        card({ kind: "approval", question: PLAN_QUESTION, specVersion: 2 }),
      );
      const bubble = element.querySelector<HTMLElement>("[data-request-bubble]")!;
      expect(element.querySelector("h3")?.textContent).toBe("목표 그래프 플랜 승인 부탁드려요.");
      expect([...bubble.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "별자리 배치",
      ]);
      expect([...bubble.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "승인",
        "자세히 보기",
      ]);
      for (const hidden of ["찾기 어려워요", "150개에서 느려질", "검사 미통과", "2번째 확인"]) {
        expect(bubble.textContent?.includes(hidden)).toBe(false);
      }

      await userEvent.click(buttonIn(element, "자세히 보기"));
      const details = element.querySelector<HTMLElement>("[data-request-details]")!;
      expect(
        [...details.querySelectorAll("dl > div")].map((row) => [
          row.querySelector("dt")?.textContent,
          row.querySelector("dd")?.textContent,
        ]),
      ).toEqual([
        ["단계", "같은 데이터는 같은 모양"],
        ["문제", "목표 이름이 잘려서 찾기 어려워요."],
        ["현재 상태", "GoalGraph.tsx가 격자로 그려요."],
        ["안 하는 것", "격자 색 변경"],
        ["위험", "150개에서 느려질 수 있어요."],
      ]);
      const check = details.querySelector<HTMLElement>("[data-plan-check]")!;
      expect(check.querySelector("p")?.textContent).toBe(
        "검사 미통과 · 2번째 확인 · Claude Opus 4.7",
      );
      expect([...check.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "문제 통과",
        "위험 미통과위험이 할 일과 이어지지 않아요.",
      ]);
      await page.screenshot({ path: `__screenshots__/request-message-plan-gates-${width}.png` });
    });

    it("hides checker verdicts for another plan version", async () => {
      server.detail = {
        task: {
          planCheck: {
            specVersion: 1,
            round: 1,
            status: "passed",
            verdicts: [{ gate: "problem", pass: true, reason: "좋아요." }],
            checker: null,
            startedAt: ASKED_AT,
            checkedAt: ASKED_AT,
            ask: { question: PLAN_QUESTION, context: {} },
          },
        },
        versions: [{ version: 2, spec: { ...emptyProjectTaskSpec(), problem: "문제 내용" } }],
      } as unknown as ProjectTeamTaskDetail;
      const element = await open(
        card({ kind: "approval", question: PLAN_QUESTION, specVersion: 2 }),
      );
      await userEvent.click(buttonIn(element, "자세히 보기"));
      const details = element.querySelector<HTMLElement>("[data-request-details]")!;
      expect(details.textContent).toContain("문제 내용");
      expect(details.querySelector("[data-plan-check]")).toBeNull();
    });

    it("approves the recommended release option directly", async () => {
      const element = await open(card({ question: RELEASE }));
      expect([...element.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual([
        "main 최신 확인",
        "릴리스 워크플로 실행",
        "세 플랫폼 빌드 확인",
        "릴리스 노트 게시",
      ]);
      await userEvent.click(buttonIn(element, "승인"));
      await vi.waitFor(() => expect(server.answers[0]?.answer).toBe(OPTIONS[0]));
    });

    it("restarts a stalled task from 다시 시작, with the cause under 자세히 보기", async () => {
      const element = await open(
        card({
          kind: "blocker",
          question:
            "로그인 리다이렉트 수정 작업이 20분째 멈춰 있어요. 다시 시작할까요?\n\n리드가 끝내지도 묻지도 않고 멈춰서 10분 전에 한 번 깨웠는데 그대로예요.\n\n다시 시작하면 리드가 멈춘 곳부터 이어서 해요. 되돌릴 수 있어요.",
          options: ["다시 시작"],
          details: [
            { label: "원인", text: "진행 없음" },
            { label: "멈춘 시간", text: "20분" },
          ],
          context: {
            action: "멈춘 작업을 리드가 멈춘 곳부터 이어서 하도록 다시 시작해요.",
            reason: "진행할 수 있었는데 시스템이나 절차 때문에 멈춰 있어요.",
            impacts: [],
            cost: null,
            reversibility: "reversible",
            recommendation: "다시 시작을 추천해요.",
          },
        }),
      );
      const bubble = element.querySelector<HTMLElement>("[data-request-bubble]")!;
      expect([...bubble.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "다시 시작",
        "자세히 보기",
      ]);
      await userEvent.click(buttonIn(element, "자세히 보기"));
      expect(element.querySelector("[data-request-details]")?.textContent).toContain("진행 없음");
      // One answer only: no option list or note form under details.
      expect(element.querySelectorAll('input[type="radio"]')).toHaveLength(0);
      expect(element.textContent?.includes("영향 확인 필요")).toBe(false);
      await page.screenshot({ path: `__screenshots__/request-message-stall-${width}.png` });
      await userEvent.click(buttonIn(element, "다시 시작"));
      await vi.waitFor(() => expect(server.answers[0]?.answer).toBe("다시 시작"));
      expect(server.leadMessages.at(-1)).toContain("→ 다시 시작");
    });

    it("opens details and sends another option with a note", async () => {
      const element = await open(
        card({ question: RELEASE, details: [{ label: "위험", text: "되돌리기 쉬워요" }] }),
      );
      expect(element.querySelector("[data-request-details]")).toBeNull();
      await userEvent.click(buttonIn(element, "자세히 보기"));
      expect(element.querySelector("dt")?.textContent).toBe("위험");
      expect(element.querySelector("dd")?.textContent).toBe("되돌리기 쉬워요");
      const radios = element.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      expect(radios[0]?.checked).toBe(true);
      expect(element.textContent).toContain("추천");
      await userEvent.click(radios[1]!);
      await userEvent.type(element.querySelector("textarea")!, "내일 해주세요");
      await page.screenshot({ path: `__screenshots__/request-message-details-${width}.png` });
      await userEvent.click(buttonIn(element, "보내기"));
      await vi.waitFor(() =>
        expect(server.answers[0]?.answer).toBe(`${OPTIONS[1]}\nNote: 내일 해주세요`),
      );
    });

    it("shows the reason, cost and recommendation under details", async () => {
      const element = await open(
        card({
          question: RELEASE,
          context: {
            action: "v0.0.20 릴리스를 냅니다",
            reason: "머지된 변경 네 개를 묶어서 냅니다",
            impacts: ["publish"],
            cost: null,
            reversibility: "requires_work",
            recommendation: "지금 내는 안을 추천해요",
          },
        }),
      );
      expect(element.textContent).not.toContain("머지된 변경 네 개를 묶어서 냅니다");
      await userEvent.click(buttonIn(element, "자세히 보기"));
      const context = element.querySelector<HTMLElement>(
        '[data-request-details] [data-attention-context="known"]',
      )!;
      expect(context.querySelector("[data-attention-reason]")?.textContent).toBe(
        "머지된 변경 네 개를 묶어서 냅니다",
      );
      expect(context.textContent).toContain("지금 내는 안을 추천해요");
      expect(context.textContent).toContain("외부 게시");
    });

    it("opens the existing lead side chat", async () => {
      const element = await open(card());
      await userEvent.click(buttonIn(element, "자세히 보기"));
      await userEvent.click(buttonIn(element, "리드와 대화"));
      await vi.waitFor(() =>
        expect(
          document.querySelector("[data-card-side-chat]")?.getAttribute("data-card-side-chat"),
        ).toBe("attention-plan"),
      );
    });

    it("prepends a request link to the existing composer draft", async () => {
      useComposerDraftStore.getState().setPrompt(ref, "내 의견");
      const element = await open(card({ question: RELEASE }));
      await userEvent.hover(element);
      await userEvent.click(buttonIn(element, "답장"));
      expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
        `${formatRequestLink("attention-plan", "v0.0.20 릴리스 해도 될까요?")} 내 의견`,
      );
    });

    it("replaces the request link when replying to another request", async () => {
      useComposerDraftStore.getState().setPrompt(ref, "내 의견");
      const plan = await open(card());
      await userEvent.hover(plan);
      await userEvent.click(buttonIn(plan, "답장"));
      const release = await open(
        card({ id: ProjectAttentionItemId.make("attention-release"), question: RELEASE }),
      );
      await userEvent.hover(release);
      await userEvent.click(buttonIn(release, "답장"));
      expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
        `${formatRequestLink("attention-release", "v0.0.20 릴리스 해도 될까요?")} 내 의견`,
      );
    });

    it("sends a reply from another chat to the project PM's composer", async () => {
      const director = scopeThreadRef("environment-local" as never, ThreadId.make("director"));
      const entry = card({ question: RELEASE });
      server.summary = { ...server.summary!, openCount: 1, decisionCards: [entry] };
      await act(async () =>
        root.render(
          <DecisionCard
            card={entry}
            environmentId={"environment-local" as never}
            threadRef={director}
            cwd={undefined}
          />,
        ),
      );
      const element = cardElement("open")!;
      await userEvent.hover(element);
      await userEvent.click(buttonIn(element, "답장"));
      // Only the PM's chat ties a reply to its request, so the link lands there and the app goes there.
      expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toContain(
        formatRequestLink("attention-plan", "v0.0.20 릴리스 해도 될까요?"),
      );
      expect(useComposerDraftStore.getState().getComposerDraft(director)?.prompt ?? "").toBe("");
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ params: expect.objectContaining({ threadId: PM_THREAD_ID }) }),
      );
    });

    it("renders a request link as a quote chip and scrolls to the request", async () => {
      const entry = card({ question: RELEASE });
      server.summary = { ...server.summary!, decisionCards: [entry] };
      await act(async () =>
        root.render(
          <>
            <TeamCards />
            <ChatMarkdown
              text={formatRequestLink(entry.item.id, "v0.0.20 릴리스 해도 될까요?")}
              cwd={undefined}
              environmentId={EnvironmentId.make("environment-local")}
            />
          </>,
        ),
      );
      const target = container.querySelector<HTMLElement>("[data-decision-card]")!;
      const scroll = vi.spyOn(target, "scrollIntoView");
      const chip = container.querySelector<HTMLButtonElement>("[data-request-quote]")!;
      expect(chip.textContent).toBe("↩ v0.0.20 릴리스 해도 될까요?");
      await userEvent.click(chip);
      expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });
  });
}
