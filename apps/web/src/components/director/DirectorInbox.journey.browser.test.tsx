import "~/index.css";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  TURN_FAILED_OPTIONS,
  PLAN_APPROVAL_START,
  type ProjectDecisionCard,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamSnoozeDecisionInput,
  type ProjectTeamUnsnoozeDecisionInput,
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
import { DecisionCard } from "../chat/DecisionCard";
import { DirectorPendingActions, ThreadPendingActions } from "../chat/PendingActionsButton";
import {
  openPendingActions,
  pendingButton,
  pendingDialog,
} from "../chat/PendingActionsButton.testing";
import { DirectorInbox } from "./DirectorInbox";

const AT = "2026-11-09T01:00:00.000Z";
const state = vi.hoisted(() => ({
  managers: [] as ProjectManagerEntry[],
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
  snoozes: [] as ProjectTeamSnoozeDecisionInput[],
  revealed: [] as string[],
}));

/** Mirrors ProjectTeamService.snoozeDecision: the card stays open, marked snoozed. */
function publishSnooze(id: string, reason: string | null) {
  state.managers = state.managers.map((entry) => ({
    ...entry,
    summary: {
      ...entry.summary,
      decisionCards: entry.summary.decisionCards.map((card) =>
        card.item.id === id
          ? {
              ...card,
              item: { ...card.item, snoozedAt: reason === null ? null : AT, snoozeReason: reason },
            }
          : card,
      ),
    },
  }));
  for (const listener of state.listeners) listener();
  return AsyncResult.success({});
}

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
  useSnoozeDecision: (() =>
    async (_environmentId: unknown, input: ProjectTeamSnoozeDecisionInput) => {
      state.snoozes.push(input);
      return publishSnooze(input.attentionItemId, input.reason);
    }) as never,
  useUnsnoozeDecision: (() =>
    async (_environmentId: unknown, input: ProjectTeamUnsnoozeDecisionInput) =>
      publishSnooze(input.attentionItemId, null)) as never,
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
      details: null,
      senderRole: null,
      senderName: null,
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
  return (
    <div className="min-w-0 flex-1 p-3">
      {cards.map((card) => (
        <DecisionCard
          key={card.item.id}
          card={card}
          environmentId={ref.environmentId}
          threadRef={ref}
          cwd={undefined}
        />
      ))}
      <div style={{ display: "flex", justifyContent: "center", padding: "6px 0" }}>
        {threadId === "pm-director" ? (
          <DirectorPendingActions onRevealCard={(id) => state.revealed.push(id)} />
        ) : (
          <ThreadPendingActions
            cards={cards}
            waitingThreads={entry?.summary.waitingThreads ?? []}
            environmentId={ref.environmentId}
            threadRef={ref}
            cwd={undefined}
            onRevealCard={(id) => state.revealed.push(id)}
            onOpenThread={(threadId) => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: ref.environmentId, threadId },
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answers = [];
  state.snoozes = [];
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
        decisionCards: [card("director", "총괄", "decision", 3)],
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

async function renderChat(threadId: string) {
  const base = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [`/env/${threadId}`] }),
    routeTree: base.addChildren([
      createRoute({
        getParentRoute: () => base,
        path: "/$environmentId/$threadId",
        component: Chat,
      }),
    ]),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

/** The project groups in the dialog. */
const dialogProjects = () =>
  [...(pendingDialog()?.querySelectorAll<HTMLElement>("[data-director-inbox-project]") ?? [])].map(
    (group) => group.dataset.directorInboxProject,
  );

function expectInsideViewport(element: HTMLElement, width: number) {
  const rect = element.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(width + 0.5);
}

for (const width of [1280, 390]) {
  describe(`director waiting button at ${width}px`, () => {
    it("shows a small button instead of the inbox and lists every project", async () => {
      await page.viewport(width, 844);
      await renderChat("pm-director");

      // No inbox dock: just the pill with every project's waiting items.
      const pill = await vi.waitFor(() => {
        const button = pendingButton();
        if (!button) throw new Error("no pending button yet");
        return button;
      });
      expect(pill.textContent).toBe("기다리는 일 6개");
      expect(pill.getBoundingClientRect().height).toBeLessThanOrEqual(32);
      expect(container.querySelector("[data-director-inbox]")).toBeNull();
      expect(document.body.textContent).not.toContain("받은편지함");

      const dialog = await openPendingActions();
      expect(dialog.textContent).toContain("나를 기다리는 일 6");
      // One title with the count; the list doesn't repeat it.
      expect(dialog.textContent!.split("나를 기다리는 일")).toHaveLength(2);
      expect(dialogProjects()).toEqual(expect.arrayContaining(["a", "b", "director"]));
      expect(dialog.querySelectorAll("[data-decision-card]")).toHaveLength(4);
      expect(dialog.textContent).toContain("결정 작업 · 프로젝트 A");
      expect(dialog.textContent).toContain("접근 허용");
      expect(
        dialog
          .querySelector<HTMLAnchorElement>("[data-director-inbox-task-link]")
          ?.getAttribute("href"),
      ).toContain("/tasks/env/");
      expectInsideViewport(dialog, width);
      await page.screenshot({ path: `__screenshots__/director-pending-actions-${width}.png` });
    });

    it("answers in the dialog, the count drops, and the button hides at zero", async () => {
      await page.viewport(width, 844);
      await renderChat("pm-director");
      await vi.waitFor(() => expect(pendingButton()).not.toBeNull());
      const dialog = await openPendingActions();
      const decision = cardIn(dialog, "결정");
      await userEvent.click(
        [...decision.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "자세히 보기",
        )!,
      );
      await userEvent.click(
        [...decision.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "보내기",
        )!,
      );
      await vi.waitFor(() => expect(state.answers).toHaveLength(1));
      expect(state.answers[0]).toMatchObject({
        projectId: "a",
        attentionItemId: "결정",
        answer: "첫 번째",
      });
      await act(() => publishAnswered("결정"));
      await vi.waitFor(() => {
        expect(pendingButton()?.textContent).toBe("기다리는 일 5개");
        expect(pendingDialog()?.textContent).toContain("나를 기다리는 일 5");
        expect(pendingDialog()?.querySelector('[data-decision-card="결정"]')).toBeNull();
      });

      // Everything else gets handled: the dialog closes and the button goes away.
      await act(() => {
        for (const id of ["실패", "총괄", "계획"]) publishAnswered(id);
        state.managers = state.managers.map((entry) => ({
          ...entry,
          summary: { ...entry.summary, waitingThreads: [] },
        }));
        for (const listener of state.listeners) listener();
      });
      await vi.waitFor(() => {
        expect(pendingButton()).toBeNull();
        expect(pendingDialog()).toBeNull();
      });
    });

    it("opens a waiting thread from the dialog and closes it", async () => {
      await page.viewport(width, 844);
      const router = await renderChat("pm-director");
      await vi.waitFor(() => expect(pendingButton()).not.toBeNull());
      const dialog = await openPendingActions();
      const row = [...dialog.querySelectorAll<HTMLElement>("div.border-dashed")].find((candidate) =>
        candidate.textContent?.includes("접근 허용"),
      )!;
      await userEvent.click(buttonIn(row, "열기"));
      await vi.waitFor(() => {
        expect(router.state.location.pathname).toBe("/env/waiting-b");
        expect(pendingDialog()).toBeNull();
      });
    });

    it("jumps from the dialog to one of the Director's own cards", async () => {
      await page.viewport(width, 844);
      await renderChat("pm-director");
      await vi.waitFor(() => expect(pendingButton()).not.toBeNull());
      const dialog = await openPendingActions();
      // Only the Director's own cards live in this chat's timeline.
      const reveal = [...dialog.querySelectorAll("button")].filter(
        (button) => button.textContent === "채팅에서 보기",
      );
      expect(reveal).toHaveLength(1);
      await userEvent.click(reveal[0]!);
      expect(state.revealed).toEqual(["총괄"]);
      await vi.waitFor(() => expect(pendingDialog()).toBeNull());
    });

    it("shows the same small button in a PM chat", async () => {
      await page.viewport(width, 844);
      await renderChat("pm-a");
      const pill = await vi.waitFor(() => {
        const button = pendingButton();
        if (!button) throw new Error("no pending button yet");
        return button;
      });
      expect(pill.textContent).toBe("기다리는 일 2개");
      expect(container.querySelector("[data-director-inbox]")).toBeNull();
      const dialog = await openPendingActions();
      expect(
        [...dialog.querySelectorAll<HTMLElement>("[data-pending-actions-card]")].map(
          (row) => row.dataset.pendingActionsCard,
        ),
      ).toEqual(["결정", "계획"]);
      await page.screenshot({ path: `__screenshots__/pm-pending-actions-${width}.png` });
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
            id: decision.item.taskId as never,
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

it("shows a PM's own blocker with the project name and opens that PM's chat", async () => {
  const base = card("a", "릴리스막힘", "blocker", 1);
  const blocker: ProjectDecisionCard = {
    ...base,
    taskNumber: null,
    taskTitle: "Jota",
    item: {
      ...base.item,
      taskId: null,
      askerThreadId: "pm-a" as never,
      options: ["내가 직접 실행할게요"],
    },
  };
  state.managers = [
    {
      environmentId: "env" as never,
      summary: makeProjectManagerSummaryFixture({
        projectId: "a" as never,
        pmThreadId: "pm-a" as never,
        decisionCards: [blocker],
      }),
    },
  ];
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/inbox",
        component: () => <DirectorInbox highlightCardId={null} showEmpty />,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/$environmentId/$threadId",
        component: () => <p>PM 채팅</p>,
      }),
    ]),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  const link = await vi.waitFor(() => {
    const element = container.querySelector<HTMLAnchorElement>("[data-director-inbox-task-link]");
    expect(element).toBeTruthy();
    return element!;
  });
  expect(link.textContent).toBe("Jota · 프로젝트 A");
  await page.viewport(1280, 844);
  await page.screenshot({ path: "__screenshots__/director-inbox-pm-blocker-1280.png" });
  expect(container.querySelector("[data-decision-card-meta]")?.textContent).toBe("프로젝트 A · PM");
  await userEvent.click(link);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env/pm-a"));
  expect(container.textContent).toContain("PM 채팅");
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

describe("director waiting list snooze", () => {
  it("snoozes a card with a reason into 보류 and brings it back", async () => {
    await page.viewport(1280, 844);
    await renderChat("pm-director");
    await vi.waitFor(() => expect(pendingButton()?.textContent).toBe("기다리는 일 6개"));
    const dialog = await openPendingActions();
    const row = () => cardIn(dialog, "결정").parentElement!;

    await act(async () =>
      userEvent.click(row().querySelector<HTMLElement>("[data-snooze-button]")!),
    );
    const input = await vi.waitFor(() => {
      const element = row().querySelector<HTMLInputElement>("[data-snooze-reason-input]");
      expect(element).not.toBeNull();
      expect(document.activeElement).toBe(element);
      return element!;
    });
    expect(row().querySelector<HTMLButtonElement>("[data-snooze-submit]")!.disabled).toBe(true);
    await act(async () => userEvent.type(input, "디자인 정리하고 볼게"));
    await vi.waitFor(() => expect(input.value).toBe("디자인 정리하고 볼게"));
    await page.screenshot({ path: "__screenshots__/director-snooze-reason-1280.png" });
    await act(async () =>
      userEvent.click(row().querySelector<HTMLButtonElement>("[data-snooze-submit]")!),
    );
    expect(state.snoozes).toEqual([
      { projectId: "a", attentionItemId: "결정", reason: "디자인 정리하고 볼게" },
    ]);

    const section = await vi.waitFor(() => {
      expect(pendingButton()?.textContent).toBe("기다리는 일 5개");
      expect(
        dialog.querySelectorAll("[data-director-inbox-project] [data-decision-card]"),
      ).toHaveLength(3);
      const element = dialog.querySelector<HTMLDetailsElement>("[data-snoozed-section]");
      expect(element?.querySelector("summary")?.textContent).toBe("보류 1");
      return element!;
    });
    await act(async () => userEvent.click(section.querySelector("summary")!));
    await vi.waitFor(() => {
      expect(section.open).toBe(true);
      expect(section.textContent).toContain("프로젝트 A · 결정 필요: 결정 작업");
      expect(section.textContent).toContain("이유: 디자인 정리하고 볼게");
    });
    section.scrollIntoView({ block: "end" });
    await page.screenshot({ path: "__screenshots__/director-snoozed-list-1280.png" });

    await act(async () =>
      userEvent.click(section.querySelector<HTMLElement>("[data-unsnooze-button]")!),
    );
    await vi.waitFor(() => {
      expect(pendingButton()?.textContent).toBe("기다리는 일 6개");
      expect(dialog.querySelector("[data-snoozed-section]")).toBeNull();
      expect(cardIn(dialog, "결정")).not.toBeNull();
    });
  });
});
