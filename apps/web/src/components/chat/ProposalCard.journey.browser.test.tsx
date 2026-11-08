import "~/index.css";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  ProjectDecisionCard,
  ProjectTeamAnswerDecisionInput,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
} from "@t3tools/contracts";
import { act, useSyncExternalStore } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { taskForLeadThread } from "../../state/projectTeam.logic";
import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import Sidebar from "../Sidebar";
import { Sidebar as ResponsiveSidebar, SidebarProvider, SidebarTrigger } from "../ui/sidebar";
import { AsyncResult } from "effect/reactivity";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DecisionCard } from "./DecisionCard";
import { decisionCardsForThread, isOpenDecisionCard } from "../../state/projectTeam.logic";
import { useProjectManagerEntries } from "../../state/projectTeam";

const NOW = "2026-11-05T09:00:00.000Z";

const state = vi.hoisted(() => ({
  answers: [] as ProjectTeamAnswerDecisionInput[],
  listeners: new Set<() => void>(),
  threads: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  managers: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
}));

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const jump = (key: string) => ({
    command: `thread.jump.${key}`,
    shortcut: { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true },
  });
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make([jump("1"), jump("2"), jump("3"), jump("4")]) as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => state.threads) as never,
  useProjects: (() => state.projects) as never,
  useProject: (() => state.projects[0]) as never,
  useServerConfigs: (() => new Map()) as never,
  useEnvironmentIdentities: (() => []) as never,
}));
vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: (() => state.groups) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.managers,
    )) as never,
  useAnswerDecision: (() =>
    async (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) => {
      state.answers.push(input);
      return AsyncResult.success({});
    }) as never,
  useEnvironmentProjectTeamAttention: (() => ({
    byProjectId: new Map(state.managers.map((m) => [m.summary.projectId, m.summary])),
    byPmThreadId: new Map(state.managers.map((m) => [m.summary.pmThreadId, m.summary])),
  })) as never,
  useRequestSitrep: (() => vi.fn()) as never,
  // The real hook reads the summary from atoms; read it from the test's managers instead.
  useLeadThreadTask: ((ref: { threadId: string }, projectId: string | null) =>
    taskForLeadThread(
      state.managers.find((m) => m.summary.projectId === projectId)?.summary ?? null,
      ref.threadId as never,
    )) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

function threadShell(id: string, projectId: string, updatedAt: string): EnvironmentThreadShell {
  return {
    environmentId: "env-1" as never,
    id: id as never,
    projectId: projectId as never,
    title: id,
    providerInstanceId: "codex" as never,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null } as never,
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: updatedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
    lastVisitedAt: updatedAt,
    deletedAt: null,
    source: {} as never,
  };
}

function project(id: string, title: string) {
  return {
    id,
    environmentId: "env-1",
    title,
    workspaceRoot: `/repo/${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function projectGroup(id: string, title: string) {
  const member = project(id, title);
  return {
    ...member,
    projectKey: `env-1:${id}`,
    displayName: title,
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    memberProjects: [member],
    memberProjectRefs: [{ environmentId: "env-1", projectId: id }],
    remoteEnvironmentLabels: [],
  };
}

let root: Root;
let container: HTMLDivElement;

function renderSidebarApp() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider className="flex-col sm:flex-row">
        {/* The app's sidebar becomes a sheet on phones. */}
        <ResponsiveSidebar>
          <Sidebar />
        </ResponsiveSidebar>
        <div className="min-w-0 flex-1">
          <SidebarTrigger />
          <PmChat />
        </div>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => null,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, render: () => act(async () => root.render(<RouterProvider router={router} />)) };
}

const TITLE = "로그인 이동 수정";
const proposal: ProjectDecisionCard = {
  taskNumber: 1,
  taskTitle: TITLE,
  plan: null,
  proposal: { projectId: "busyboy" as never },
  item: {
    id: "proposal-1" as never,
    projectId: "busyboy" as never,
    taskId: "task-1" as never,
    kind: "proposal",
    question: TITLE,
    summary: "인증 뒤 **원래 화면**으로 이동",
    verification: "- 로그인 후 이동 확인",
    options: ["태스크로 추가", "빼기"],
    answer: null,
    answeredAt: null,
    askerThreadId: "pm-thread" as never,
    batchId: "batch-1" as never,
    createdAt: NOW,
    supersededAt: null,
    answeredBy: null,
    specVersion: null,
  },
};

function PmChat() {
  const entries = useProjectManagerEntries([]);
  return (
    <main aria-label="PM 채팅" className="min-w-0 flex-1">
      {decisionCardsForThread(
        entries.map((entry) => entry.summary),
        "pm-thread" as never,
      ).map((card) => (
        <DecisionCard
          key={card.item.id}
          card={card}
          environmentId={"env-1" as never}
          threadRef={scopeThreadRef("env-1" as never, "pm-thread" as never)}
          cwd={undefined}
        />
      ))}
    </main>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answers = [];
  state.projects = [project("busyboy", "Busyboy")];
  state.groups = [projectGroup("busyboy", "Busyboy")];
  state.threads = [threadShell("pm-thread", "busyboy", NOW)];
  state.managers = [
    {
      environmentId: "env-1",
      summary: makeProjectManagerSummaryFixture({
        projectId: "busyboy" as never,
        pmThreadId: "pm-thread" as never,
        openCount: 1,
        decisionCards: [proposal],
        tasks: [],
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
});

function cardElement() {
  return container.querySelector<HTMLElement>("[data-proposal-card]")!;
}
function button(text: string) {
  const element = [...cardElement().querySelectorAll("button")].find(
    (entry) => entry.textContent === text,
  );
  if (!element) {
    throw new Error(`Missing button: ${text}`);
  }
  return element;
}
function sidebarTasks() {
  return [...document.querySelectorAll("[data-task-item]")].map(
    (entry) => entry.querySelector("button")?.getAttribute("aria-label") ?? "",
  );
}
function publish(summary: ProjectTeamAttentionSummary) {
  state.managers = [{ environmentId: "env-1", summary }];
  for (const listener of state.listeners) {
    listener();
  }
}

for (const width of [1280, 390]) {
  it(`adds a proposed task only after acceptance at width ${width}`, async () => {
    await page.viewport(width, 844);
    await renderSidebarApp().render();
    await vi.waitFor(() => expect(cardElement()?.textContent).toContain(TITLE));
    expect(cardElement().textContent).toContain("태스크 제안 · Busyboy");
    expect(cardElement().textContent).toContain("목표");
    expect(cardElement().textContent).toContain("원래 화면");
    expect(cardElement().textContent).toContain("확인 방법");
    expect(cardElement().textContent).toContain("로그인 후 이동 확인");
    if (width === 390) {
      await userEvent.click(page.getByRole("button", { name: "Toggle Sidebar" }));
      await vi.waitFor(() => expect(document.querySelector('[data-mobile="true"]')).toBeTruthy());
    }
    expect(sidebarTasks().some((title) => title.includes(TITLE))).toBe(false);
    if (width === 390) {
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.querySelector('[data-mobile="true"]')).toBeNull());
    }
    expect(isOpenDecisionCard(proposal)).toBe(true);
    expect(button("피드백 보내기").disabled).toBe(true);
    expect(cardElement().scrollWidth).toBeLessThanOrEqual(cardElement().clientWidth);
    await act(async () => button("태스크로 추가").click());
    expect(state.answers).toEqual([
      { projectId: "busyboy", attentionItemId: "proposal-1", answer: "태스크로 추가" },
    ]);

    // Only the server's accepted snapshot adds the task to the sidebar.
    const task: ProjectTaskReference = {
      id: "task-1" as never,
      number: 1,
      parentTaskId: null,
      waitsOn: [],
      title: TITLE,
      stage: "inbox",
      leadThreadId: null,
      prUrl: null,
      lastOutcome: null,
      openQuestion: false,
      openBlocker: false,
      iterateRound: 0,
      shipRound: 0,
      modelSteps: {},
      updatedAt: null,
    };
    await act(async () =>
      publish({
        ...state.managers[0]!.summary,
        openCount: 0,
        tasks: [task],
        decisionCards: [
          {
            ...proposal,
            item: {
              ...proposal.item,
              answer: "태스크로 추가",
              answeredAt: NOW,
              answeredBy: "user",
            },
          },
        ],
      }),
    );
    if (width === 390) {
      await userEvent.click(page.getByRole("button", { name: "Toggle Sidebar" }));
    }
    await vi.waitFor(() =>
      expect(sidebarTasks().some((title) => title.includes(TITLE))).toBe(true),
    );
    if (width === 390) {
      const sheet = document.querySelector<HTMLElement>('[data-mobile="true"]')!;
      expect(sheet.getBoundingClientRect().width).toBeLessThanOrEqual(width);
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.querySelector('[data-mobile="true"]')).toBeNull());
    }
    expect(cardElement().dataset.proposalCardState).toBe("answered");
    expect(cardElement().textContent).toContain(`추가됨 · ${TITLE}`);
  });

  it(`sends dismissal and feedback at width ${width}`, async () => {
    await page.viewport(width, 844);
    await renderSidebarApp().render();
    await act(async () => button("빼기").click());
    expect(state.answers[0]?.answer).toBe("빼기");
    await act(async () =>
      publish({
        ...state.managers[0]!.summary,
        decisionCards: [
          { ...proposal, item: { ...proposal.item, answer: "빼기", answeredAt: NOW } },
        ],
      }),
    );
    expect(cardElement().textContent).toContain(`뺌 · ${TITLE}`);
    // A new proposal has its own feedback draft and sending state.
    await act(async () =>
      publish({
        ...state.managers[0]!.summary,
        decisionCards: [{ ...proposal, item: { ...proposal.item, id: "proposal-2" as never } }],
      }),
    );
    const feedback = cardElement().querySelector("textarea")!;
    for (const reserved of [" 태스크로 추가 ", " 빼기 "]) {
      await userEvent.fill(feedback, reserved);
      expect(button("피드백 보내기").disabled).toBe(true);
    }
    await userEvent.fill(feedback, "태스크로 추가\n범위를 줄여주세요");
    expect(button("피드백 보내기").disabled).toBe(false);
    await act(async () => button("피드백 보내기").click());
    expect(state.answers[1]).toEqual({
      projectId: "busyboy",
      attentionItemId: "proposal-2",
      answer: "태스크로 추가\n범위를 줄여주세요",
    });
    await act(async () =>
      publish({
        ...state.managers[0]!.summary,
        decisionCards: [
          {
            ...proposal,
            item: {
              ...proposal.item,
              id: "proposal-2" as never,
              answer: "태스크로 추가\n범위를 줄여주세요",
              answeredAt: NOW,
            },
          },
        ],
      }),
    );
    expect(cardElement().textContent).toContain(`피드백 보냄 · ${TITLE}`);
  });
}
