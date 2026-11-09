import "~/index.css";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  TURN_FAILED_OPTIONS,
  PLAN_APPROVAL_START,
  type ProjectDecisionCard,
  type ProjectTeamAnswerDecisionInput,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  useNavigate,
} from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ProjectManagerEntry } from "~/state/projectTeam";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { makeProjectManagerSummaryFixture } from "~/test-fixtures";
import { pendingActionItems } from "~/state/projectTeam.logic";
import { DecisionCard } from "../chat/DecisionCard";
import { ComposerBannerStack } from "../chat/ComposerBannerStack";
import { pendingActionsBannerItem } from "../chat/PendingActionsBar";
import { DirectorInboxDock } from "./DirectorInboxDock";
import { DirectorInbox } from "./DirectorInbox";

const AT = "2026-11-09T01:00:00.000Z";
const state = vi.hoisted(() => ({
  managers: [] as ProjectManagerEntry[],
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
  revealed: [] as string[],
}));

vi.mock(import("~/state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state.managers,
    )) as never,
  useAnswerDecision: (() =>
    async (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) => {
      state.answers.push(input);
      return AsyncResult.success({});
    }) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env"]) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() =>
    ["a", "b"].map((id) => ({
      id,
      environmentId: "env",
      title: `프로젝트 ${id.toUpperCase()}`,
      workspaceRoot: `/repo/${id}`,
      createdAt: AT,
      updatedAt: AT,
    }))) as never,
  useThreadShell: (() => null) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

function card(
  projectId: string,
  id: string,
  kind: ProjectDecisionCard["item"]["kind"],
  hour: number,
): ProjectDecisionCard {
  return {
    taskNumber: hour,
    taskTitle: `${id} 작업`,
    proposal: kind === "proposal" ? { projectId: projectId as never } : null,
    plan: null,
    item: {
      id: id as never,
      projectId: projectId as never,
      taskId: `task-${id}` as never,
      kind,
      question: `${id} 어떻게 할까요?`,
      options:
        kind === "blocker"
          ? [...TURN_FAILED_OPTIONS]
          : kind === "approval"
            ? [PLAN_APPROVAL_START]
            : ["첫 번째", "두 번째"],
      answer: null,
      answeredAt: null,
      supersededAt: null,
      createdAt: `2026-11-09T0${hour}:00:00.000Z`,
      askerThreadId: `pm-${projectId}` as never,
      batchId: "batch" as never,
      answeredBy: null,
      specVersion: null,
      summary: "진행할 계획",
      verification: "화면 확인",
      context: {
        action: `${id} 변경을 로컬에서 구현합니다.`,
        reason: "사용자가 겪는 오류를 고칩니다.",
        impacts: [],
        cost: null,
        reversibility: "reversible",
        recommendation: "로컬 검증 후 결과를 확인합니다.",
      },
    },
  };
}

function publishAnswered(id: string) {
  state.managers = state.managers.map((entry) => ({
    ...entry,
    summary: {
      ...entry.summary,
      decisionCards: entry.summary.decisionCards.map((card) =>
        card.item.id === id
          ? {
              ...card,
              item: {
                ...card.item,
                answer:
                  state.answers.find((answer) => answer.attentionItemId === id)?.answer ?? "답변",
                answeredAt: AT,
                answeredBy: "user",
              },
            }
          : card,
      ),
    },
  }));
  for (const listener of state.listeners) {
    listener();
  }
}

/** Render the same pending-actions integration ChatView uses, alongside its PM cards. */
function Chat() {
  const { threadId } = useParams({ strict: false });
  const navigate = useNavigate();
  const entries = useProjectManagerEntries([]);
  const entry = entries.find((entry) => entry.summary.pmThreadId === threadId);
  const cards = entry?.summary.decisionCards ?? [];
  const ref = scopeThreadRef("env" as never, threadId as never);
  const banner = pendingActionsBannerItem({
    id: `pending-actions:${threadId}`,
    items: pendingActionItems({ cards, waitingThreads: entry?.summary.waitingThreads ?? [] }),
    onRevealCard: (id) => state.revealed.push(id),
    onOpenThread: (threadId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ref.environmentId, threadId },
      });
    },
  });
  return (
    <div className="min-w-0 flex-1 p-3">
      {threadId === "pm-director" ? <DirectorInboxDock /> : null}
      <ComposerBannerStack items={banner === null ? [] : [banner]} />
      {cards.map((card) => (
        <DecisionCard
          key={card.item.id}
          card={card}
          environmentId={ref.environmentId}
          threadRef={ref}
          cwd={undefined}
        />
      ))}
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answers = [];
  state.revealed = [];
  state.managers = [
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "b" as never,
        pmThreadId: "pm-b" as never,
        taskKeyPrefix: "B",
        decisionCards: [card("b", "실패", "blocker", 2)],
        waitingThreads: [{ threadId: "waiting-b" as never, title: "접근 허용", kind: "approval" }],
      }),
    },
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "director" as never,
        pmThreadId: "pm-director" as never,
        kind: "director",
        persona: { name: "총괄", avatar: { kind: "emoji", emoji: "🧭" }, voice: "chill" },
        decisionCards: [card("director", "제안", "proposal", 3)],
        waitingThreads: [
          { threadId: "waiting-director" as never, title: "총괄 허용", kind: "approval" },
        ],
      }),
    },
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "a" as never,
        pmThreadId: "pm-a" as never,
        taskKeyPrefix: "A",
        decisionCards: [card("a", "결정", "decision", 1), card("a", "계획", "approval", 4)],
      }),
    },
  ];
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buttonIn(element: Element, label: string) {
  const button = [...element.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Missing button ${label}`);
  }
  return button;
}
const cardIn = (element: Element, id: string) =>
  element.querySelector<HTMLElement>(`[data-decision-card="${id}"]`)!;

for (const width of [1280, 390]) {
  describe(`director inbox at ${width}px`, () => {
    it("reaches the Director's own waiting thread through its chat banner", async () => {
      await page.viewport(width, 844);
      const base = createRootRoute({ component: Outlet });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/env/pm-director"] }),
        routeTree: base.addChildren([
          createRoute({
            getParentRoute: () => base,
            path: "/$environmentId/$threadId",
            component: Chat,
          }),
        ]),
      });
      await act(async () => root.render(<RouterProvider router={router} />));
      await userEvent.click(page.getByRole("button", { name: "기다리는 일 보기", exact: true }));
      expect(state.revealed).toEqual(["제안"]);
      await userEvent.click(page.getByRole("button", { name: "다음 기다리는 일", exact: true }));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env/waiting-director"));
    });

    it("keeps the shown card when an earlier card is answered elsewhere", async () => {
      await page.viewport(width, 844);
      const base = createRootRoute({ component: Outlet });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/env/pm-director"] }),
        routeTree: base.addChildren([
          createRoute({
            getParentRoute: () => base,
            path: "/$environmentId/$threadId",
            component: Chat,
          }),
        ]),
      });
      await act(async () => root.render(<RouterProvider router={router} />));
      const inbox = () => container.querySelector<HTMLElement>("[data-director-inbox]")!;
      await userEvent.click(page.getByRole("button", { name: "다음 카드", exact: true }));
      expect(cardIn(inbox(), "실패")).toBeTruthy();
      await act(() => publishAnswered("결정"));
      expect(inbox().textContent).toContain("받은편지함 1/3");
      expect(cardIn(inbox(), "실패")).toBeTruthy();
      await act(() => publishAnswered("실패"));
      expect(inbox().textContent).toContain("받은편지함 1/2");
      expect(cardIn(inbox(), "계획")).toBeTruthy();
    });

    it("steps oldest first, answers in place, and shares answers with the PM", async () => {
      await page.viewport(width, 844);
      const base = createRootRoute({ component: Outlet });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/env/pm-director"] }),
        routeTree: base.addChildren([
          createRoute({
            getParentRoute: () => base,
            path: "/$environmentId/$threadId",
            component: Chat,
          }),
        ]),
      });
      await act(async () => root.render(<RouterProvider router={router} />));
      const inbox = () => container.querySelector<HTMLElement>("[data-director-inbox]")!;
      await vi.waitFor(() => expect(inbox().textContent).toContain("받은편지함 1/4"));
      expect(page.getByRole("region", { name: "받은편지함", exact: true }).element()).toBe(inbox());
      expect(container.querySelectorAll('[data-decision-card="제안"]')).toHaveLength(1);
      expect(inbox().querySelector('[data-decision-card="제안"]')).toBeNull();
      expect(inbox().querySelectorAll("[data-decision-card]")).toHaveLength(1);
      expect(inbox().textContent).toContain("결정 작업 · 프로젝트 A");
      expect(
        inbox()
          .querySelector<HTMLAnchorElement>("[data-director-inbox-task-link]")
          ?.getAttribute("href"),
      ).toContain("/tasks/env/a/task-");
      expect(inbox().querySelector("[data-attention-action]")?.textContent).toBe(
        "결정 변경을 로컬에서 구현합니다.",
      );
      await userEvent.click(page.getByRole("button", { name: "다음 카드", exact: true }));
      expect(inbox().textContent).toContain("실패 작업 · 프로젝트 B");
      await userEvent.click(page.getByRole("button", { name: "이전 카드", exact: true }));
      const decision = cardIn(inbox(), "결정");
      await userEvent.click(decision.querySelector<HTMLButtonElement>('[role="radio"]')!);
      await userEvent.click(
        decision.querySelector<HTMLButtonElement>("[data-decision-card-submit]")!,
      );
      await vi.waitFor(() => expect(state.answers).toHaveLength(1));
      expect(state.answers[0]).toMatchObject({
        projectId: "a",
        attentionItemId: "결정",
        answer: "첫 번째",
      });
      await act(() => publishAnswered("결정"));
      await vi.waitFor(() => expect(inbox().textContent).toContain("받은편지함 1/3"));
      expect(cardIn(inbox(), "실패")).toBeTruthy();
      // Answer the next card from its project's chat, then return to the same shared summary.
      await act(async () => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env", threadId: "pm-b" },
        });
      });
      await userEvent.click(buttonIn(cardIn(container, "실패"), "다시 시도"));
      await vi.waitFor(() => expect(state.answers).toHaveLength(2));
      await act(() => publishAnswered("실패"));
      await act(async () => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env", threadId: "pm-director" },
        });
      });
      await vi.waitFor(() => expect(inbox().textContent).toContain("받은편지함 1/2"));
      expect(cardIn(inbox(), "실패")).toBeNull();
      expect(inbox().textContent).not.toContain("총괄");
      await userEvent.click(page.getByRole("button", { name: "다음 카드", exact: true }));
      expect(inbox().textContent).toContain("받은편지함 2/2");
      // Closing cards while positioned at the end clamps the position to the remaining item.
      await act(() => {
        publishAnswered("계획");
      });
      await vi.waitFor(() => expect(inbox().textContent).toContain("받은편지함 1/1"));
      await userEvent.click(buttonIn(inbox(), "열기"));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env/waiting-b"));
    });
  });
}

it("opens a Director card's task in its actual project without a lead thread", async () => {
  const decision = card("director", "프로젝트간결정", "decision", 1);
  state.managers = [
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "director" as never,
        pmThreadId: "pm-director" as never,
        kind: "director",
        decisionCards: [decision],
      }),
    },
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "a" as never,
        pmThreadId: "pm-a" as never,
        tasks: [
          {
            id: decision.item.taskId,
            number: 1,
            title: decision.taskTitle,
            stage: "running",
            parentTaskId: null,
            waitsOn: [],
            leadThreadId: null,
            prUrl: null,
            lastOutcome: null,
            openQuestion: true,
            openBlocker: false,
            iterateRound: 0,
            shipRound: 0,
            modelSteps: {},
            updatedAt: AT,
          },
        ],
      }),
    },
  ];
  const base = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
    routeTree: base.addChildren([
      createRoute({
        getParentRoute: () => base,
        path: "/inbox",
        component: () => <DirectorInbox highlightCardId={null} showEmpty />,
      }),
      createRoute({
        getParentRoute: () => base,
        path: "/tasks/$environmentId/$projectId/$taskId",
        component: () => <p>태스크 화면</p>,
      }),
    ]),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  const link = await vi.waitFor(() => {
    const element = container.querySelector<HTMLAnchorElement>("[data-director-inbox-task-link]");
    expect(element).toBeTruthy();
    return element!;
  });
  expect(link.textContent).toBe("프로젝트간결정 작업 · 프로젝트 A");
  await userEvent.click(link);
  await vi.waitFor(() => expect(router.state.location.pathname).toContain("/tasks/env/a/task-"));
  expect(container.textContent).toContain("태스크 화면");
});

it("does not present the Director's chat project as an unresolved task's owner", async () => {
  const decision = card("director", "소유확인", "decision", 1);
  state.managers = [
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "director" as never,
        pmThreadId: "pm-director" as never,
        kind: "director",
        tasks: [],
        decisionCards: [decision],
      }),
    },
  ];
  const base = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
    routeTree: base.addChildren([
      createRoute({
        getParentRoute: () => base,
        path: "/inbox",
        component: () => <DirectorInbox highlightCardId={null} showEmpty />,
      }),
    ]),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  await vi.waitFor(() =>
    expect(container.textContent).toContain("소유확인 작업 · 프로젝트 확인 필요"),
  );
  expect(container.querySelector("[data-director-inbox-task-link]")).toBeNull();
  expect(container.querySelector("[data-attention-task-link]")).toBeNull();
});
