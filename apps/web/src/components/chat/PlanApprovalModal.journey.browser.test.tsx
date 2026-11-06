import {
  EnvironmentId,
  PLAN_APPROVAL_START,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTeamAnswerDecisionInput,
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

import { PlanApprovalCard } from "./PlanApprovalCard";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const TASK_ID = ProjectTaskId.make("task-32");
const AT = "2026-11-05T03:00:00.000Z";

/** The server side: the approval card and the answers sent to the task lead. */
const server = vi.hoisted(() => ({
  card: null as ProjectDecisionCard | null,
  detail: null as ProjectTeamTaskDetail | null,
  listeners: new Set<() => void>(),
  answers: [] as ProjectTeamAnswerDecisionInput[],
}));

function publishCard(card: ProjectDecisionCard) {
  server.card = card;
  for (const listener of server.listeners) listener();
}

/** Mirrors AttentionRouter.answer: the stream then shows the card answered. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  const card = server.card!;
  publishCard({
    ...card,
    item: { ...card.item, answer: input.answer, answeredAt: AT, answeredBy: "user" },
  });
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
}));

function todo(id: string, text: string) {
  return { id, text, done: false, subtaskId: null };
}

function version(n: number, goal: string, todos: ReturnType<typeof todo>[]) {
  return {
    taskId: TASK_ID,
    version: n,
    spec: {
      background: "Plan approval was removed in #103.",
      goal,
      successCriteria: "The user can approve from the PM chat.",
      nonGoals: "Changing how tasks are created.",
      todos,
    },
    author: "agent" as const,
    authorThreadId: ThreadId.make("lead-32"),
    note: `Plan v${n}`,
    createdAt: AT,
  };
}

function makeDetail(): ProjectTeamTaskDetail {
  return {
    task: {
      id: TASK_ID,
      projectId: PROJECT_ID,
      number: 32,
      title: "Plan approval modal",
      request: "",
      stage: "awaiting_approval",
      waitsOn: [],
      parentTaskId: null,
      leadThreadId: ThreadId.make("lead-32"),
      prUrl: null,
      planSummary: null,
      resultSummary: null,
      lastOutcome: null,
      nudgeCount: 0,
      stageChangedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    key: "BU-32",
    versions: [
      version(1, "Keep the scroll position after review.", [todo("t1", "Add the card")]),
      version(2, "Keep the cursor position steady after review.", [
        todo("t1", "Add the card"),
        todo("t2", "Add the modal"),
      ]),
    ],
    sessions: [],
    children: [],
    openAttention: [],
  } as unknown as ProjectTeamTaskDetail;
}

function makeCard(): ProjectDecisionCard {
  return {
    taskNumber: 32,
    taskTitle: "Plan approval modal",
    item: {
      id: ProjectAttentionItemId.make("attention-approval"),
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      kind: "approval",
      question: "Plan ready: a card in the PM chat that opens a review modal.",
      options: [],
      answer: null,
      answeredAt: null,
      askerThreadId: ThreadId.make("lead-32"),
      batchId: ProjectAttentionBatchId.make("batch-1"),
      createdAt: AT,
      supersededAt: null,
      answeredBy: null,
      specVersion: 2,
    },
  };
}

function LiveCard() {
  const card = useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.card,
  );
  return card === null ? null : <PlanApprovalCard card={card} environmentId={ENVIRONMENT_ID} />;
}

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === name && element.offsetParent !== null,
  );
  if (match === undefined) throw new Error(`No visible "${name}" button`);
  return match;
}

function modal(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-plan-review]");
  if (element === null) throw new Error("Plan review not open");
  return element;
}

function section(name: string): HTMLElement {
  const element = modal().querySelector<HTMLElement>(`[data-plan-section="${name}"]`);
  if (element === null) throw new Error(`No "${name}" section`);
  return element;
}

async function openReview() {
  await act(async () => root.render(<LiveCard />));
  const card = container.querySelector('[data-decision-card-state="open"]')!;
  expect(card.textContent).toContain("Plan approval · Plan approval modal · v2");
  expect(card.textContent).toContain("Plan ready: a card in the PM chat");
  await userEvent.click(button("Review plan"));
  await vi.waitFor(() => expect(section("End result")).toBeTruthy());
}

describe.each([
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
])("plan approval on $name", ({ width, height }) => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, height);
    server.card = makeCard();
    server.detail = makeDetail();
    server.answers = [];
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  it("requests changes with an inline comment and an overall comment", async () => {
    await openReview();
    const review = modal();
    expect(review.textContent).toContain("BU-32");
    expect(review.textContent).toContain("Waiting for approval");
    expect(section("End result").textContent).toBe("Keep the cursor position steady after review.");
    expect(section("Success criteria").textContent).toBe("The user can approve from the PM chat.");
    expect(section("Non-goals").textContent).toBe("Changing how tasks are created.");
    expect(section("Steps").querySelectorAll("li")).toHaveLength(2);
    // Full screen on phones, once the open animation settles.
    if (width < 768) {
      await vi.waitFor(() => {
        const rect = review.getBoundingClientRect();
        expect([rect.left, rect.top, rect.width, rect.height]).toEqual([0, 0, width, height]);
      });
    }

    // Nothing to send yet.
    expect(button("Request changes").disabled).toBe(true);

    await userEvent.tripleClick(section("End result"));
    await userEvent.click(await vi.waitFor(() => button("Comment")));
    await userEvent.type(
      review.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!,
      "Say which cursor.",
    );
    await userEvent.click(button("Save comment"));

    const comments = review.querySelectorAll("[data-plan-comment]");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.textContent).toContain("End result");
    expect(comments[0]!.textContent).toContain("Keep the cursor position steady after review.");
    expect(comments[0]!.textContent).toContain("Say which cursor.");
    expect(section("End result").querySelector("mark")?.textContent).toBe(
      "Keep the cursor position steady after review.",
    );

    await userEvent.type(
      review.querySelector<HTMLTextAreaElement>('textarea[aria-label="Overall comment"]')!,
      "Looks close.",
    );
    await userEvent.click(button("Request changes"));

    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    const answer = server.answers[0]!;
    expect(answer.attentionItemId).toBe("attention-approval");
    expect(answer.answer).toContain("Request changes (review of spec v2)");
    expect(answer.answer).toContain("Looks close.");
    expect(answer.answer).toContain(
      '[End result] "Keep the cursor position steady after review." → Say which cursor.',
    );
    await vi.waitFor(() => expect(document.querySelector("[data-plan-review]")).toBeNull());
    const answered = container.querySelector('[data-decision-card-state="answered"]')!;
    expect(answered.textContent).toContain("Changes requested");
  });

  it("approves and starts", async () => {
    await openReview();
    await userEvent.click(button("Approve and start"));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]!.answer).toBe(PLAN_APPROVAL_START);
    await vi.waitFor(() => expect(document.querySelector("[data-plan-review]")).toBeNull());
    const answered = container.querySelector('[data-decision-card-state="answered"]')!;
    expect(answered.textContent).toContain("Approved and started");

    // The answered card still opens the plan, read-only.
    await userEvent.click(button("View plan"));
    await vi.waitFor(() => expect(section("End result")).toBeTruthy());
    expect(modal().textContent).toContain("Approved and started");
    expect(() => button("Approve and start")).toThrow();
    expect(modal().querySelector('textarea[aria-label="Overall comment"]')).toBeNull();
  });

  it("shows word changes against the previous version", async () => {
    await openReview();
    await userEvent.click(button("Show changes"));
    const goal = section("End result");
    expect([...goal.querySelectorAll("del")].map((node) => node.textContent?.trim())).toEqual([
      "scroll",
    ]);
    expect([...goal.querySelectorAll("ins")].map((node) => node.textContent?.trim())).toEqual([
      "cursor",
      "steady",
    ]);
    expect(section("Steps").querySelector("ins")?.textContent).toContain("Add the modal");
    expect(section("Non-goals").querySelectorAll("ins, del")).toHaveLength(0);

    await userEvent.click(button("Hide changes"));
    expect(section("End result").querySelectorAll("ins, del")).toHaveLength(0);
  });
});
