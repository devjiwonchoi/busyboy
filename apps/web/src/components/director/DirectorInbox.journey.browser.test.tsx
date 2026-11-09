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
} from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ProjectManagerEntry } from "~/state/projectTeam";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { makeProjectManagerSummaryFixture } from "~/test-fixtures";
import { AllProjectsPage } from "../allProjects/AllProjectsPage";
import { DecisionCard } from "../chat/DecisionCard";
import { ComposerBannerStack } from "../chat/ComposerBannerStack";
import { followPendingAction } from "../chat/PendingActionsBar.testing";
import { WorkspaceRail } from "../sidebar/WorkspaceRail";
import { SidebarProvider } from "../ui/sidebar";
import { useDirectorPendingActions } from "./useDirectorPendingActions";

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
  const entries = useProjectManagerEntries([]);
  const entry = entries.find((entry) => entry.summary.pmThreadId === threadId);
  const cards = entry?.summary.decisionCards ?? [];
  const ref = scopeThreadRef("env" as never, threadId as never);
  const actions = useDirectorPendingActions({
    threadRef: ref,
    cards,
    onRevealCard: (id) => state.revealed.push(id),
  });
  return (
    <div className="min-w-0 flex-1 p-3">
      <ComposerBannerStack items={actions?.banner ? [actions.banner] : []} />
      {cards.map((card) => (
        <DecisionCard
          key={card.item.id}
          card={card}
          environmentId={ref.environmentId}
          threadRef={ref}
          cwd={undefined}
        />
      ))}
      {actions?.dialog}
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
    it("answers in place, shares the PM timeline, and retries through the Director dialog", async () => {
      await page.viewport(width, 844);
      const base = createRootRoute({
        component: () => (
          <SidebarProvider>
            <WorkspaceRail />
            <Outlet />
          </SidebarProvider>
        ),
      });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/all-projects"] }),
        routeTree: base.addChildren([
          createRoute({
            getParentRoute: () => base,
            path: "/all-projects",
            component: AllProjectsPage,
          }),
          createRoute({
            getParentRoute: () => base,
            path: "/$environmentId/$threadId",
            component: Chat,
          }),
        ]),
      });
      await act(async () => root.render(<RouterProvider router={router} />));
      await vi.waitFor(() => expect(container.querySelector("[data-director-inbox]")).toBeTruthy());
      const inbox = container.querySelector<HTMLElement>("[data-director-inbox]")!;
      expect(
        [...inbox.querySelectorAll("[data-director-inbox-project]")].map((group) =>
          group.getAttribute("data-director-inbox-project"),
        ),
      ).toEqual(["a", "b", "director"]);
      expect(inbox.textContent).toContain("프로젝트 A");
      expect(inbox.textContent).toContain("프로젝트 B");
      expect(inbox.textContent).toContain("A-1 결정 작업");
      expect(inbox.textContent).toContain("B-2 실패 작업");
      expect(inbox.scrollWidth).toBeLessThanOrEqual(inbox.clientWidth);
      expect(container.querySelector("[data-needs-you-total]")?.textContent).toBe("나를 기다림 5");
      expect(container.querySelector("[data-director-rail]")?.getAttribute("aria-label")).toBe(
        "총괄, 기다리는 일 5개",
      );
      expect(container.querySelector("[data-director-card] [data-proposal-card]")).toBeNull();
      const scroll = vi.spyOn(inbox, "scrollIntoView");
      await userEvent.click(container.querySelector<HTMLButtonElement>("[data-needs-you-total]")!);
      expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

      const decision = cardIn(inbox, "결정");
      await userEvent.click(decision.querySelector<HTMLButtonElement>('[role="radio"]')!);
      await userEvent.type(
        decision.querySelector<HTMLTextAreaElement>("[data-decision-card-note]")!,
        "단계별로 해 주세요",
      );
      await userEvent.click(
        decision.querySelector<HTMLButtonElement>("[data-decision-card-submit]")!,
      );
      await vi.waitFor(() => expect(state.answers).toHaveLength(1));
      expect(state.answers[0]).toMatchObject({
        projectId: "a",
        attentionItemId: "결정",
        answer: "첫 번째\nNote: 단계별로 해 주세요",
      });
      await act(() => publishAnswered("결정"));
      expect(cardIn(inbox, "결정")).toBeNull();
      expect(container.querySelector("[data-needs-you-total]")?.textContent).toBe("나를 기다림 4");
      await userEvent.click(buttonIn(cardIn(inbox, "계획"), "Approve"));
      await vi.waitFor(() =>
        expect(state.answers[1]).toMatchObject({
          projectId: "a",
          attentionItemId: "계획",
          answer: PLAN_APPROVAL_START,
        }),
      );
      await act(() => publishAnswered("계획"));
      await act(async () => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env", threadId: "pm-a" },
        });
      });
      expect(cardIn(container, "결정").dataset.decisionCardState).toBe("answered");
      await act(async () => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env", threadId: "pm-director" },
        });
      });
      expect(container.textContent).toContain("기다리는 일 3개");
      await followPendingAction("제안");
      expect(state.revealed).toEqual(["제안"]);
      await act(async () =>
        userEvent.click(page.getByRole("button", { name: "기다리는 일 목록" })),
      );
      const failureItem = document.querySelector<HTMLElement>(
        '[role="menuitem"][data-pending-action-id="실패"]',
      )!;
      expect(failureItem.textContent).toBe("프로젝트 B · 블로커: 실패 작업");
      await act(async () => userEvent.click(failureItem));
      const dialog = await vi.waitFor(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).toBeTruthy();
        return dialog!;
      });
      expect(dialog.textContent).toContain("나를 기다리는 일");
      expect(cardIn(dialog, "실패").dataset.decisionCardHighlighted).toBe("true");
      expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(width);
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
      expect(getComputedStyle(dialog).overflowY).toBe("auto");
      await userEvent.click(buttonIn(cardIn(dialog, "실패"), "다시 시도"));
      await vi.waitFor(() =>
        expect(state.answers[2]).toMatchObject({
          projectId: "b",
          attentionItemId: "실패",
          answer: "다시 시도",
        }),
      );
      await act(() => publishAnswered("실패"));
      expect(cardIn(dialog, "실패")).toBeNull();
      await userEvent.click(buttonIn(dialog, "열기"));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env/waiting-b"));
      await act(async () => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env", threadId: "pm-director" },
        });
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await followPendingAction("waiting-b");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env/waiting-b"));
    });
  });
}
