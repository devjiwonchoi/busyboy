import {
  EnvironmentId,
  PLAN_APPROVAL_START,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTaskReference,
  type ProjectTaskSpec,
  type ProjectTaskStage,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamTaskDetail,
  ProjectTaskId,
  ThreadId,
  approvalPlanOf,
  emptyProjectTaskSpec,
  newProjectTaskTodo,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { PlanApprovalCard } from "./PlanApprovalCard";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const TASK_ID = ProjectTaskId.make("task-62");
const AT = "2026-11-07T03:00:00.000Z";

/**
 * The server side: the approval card, the task's stage and spec versions, and the answers.
 * Every change notifies the UI, as the attention stream does.
 */
const server = vi.hoisted(() => ({
  card: null as ProjectDecisionCard | null,
  stage: "awaiting_approval" as ProjectTaskStage,
  versions: [] as Array<{ version: number; spec: ProjectTaskSpec }>,
  answers: [] as ProjectTeamAnswerDecisionInput[],
  listeners: new Set<() => void>(),
  tick: 0,
}));

function notify() {
  server.tick += 1;
  for (const listener of server.listeners) listener();
}

function useServerTick() {
  return useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.tick,
  );
}

function taskRef(): ProjectTaskReference {
  return {
    id: TASK_ID,
    number: 62,
    parentTaskId: null,
    waitsOn: [],
    title: "Plan view",
    stage: server.stage,
    leadThreadId: ThreadId.make("lead-62"),
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    updatedAt: AT,
  };
}

function detail(): ProjectTeamTaskDetail {
  return {
    key: "BU-62",
    task: {
      id: TASK_ID,
      projectId: PROJECT_ID,
      number: 62,
      title: "Plan view",
      stage: server.stage,
    },
    versions: server.versions.map((entry) => ({
      taskId: TASK_ID,
      version: entry.version,
      spec: entry.spec,
      author: "agent",
      authorThreadId: ThreadId.make("lead-62"),
      note: "Plan",
      createdAt: AT,
    })),
    sessions: [],
    children: [],
    openAttention: [],
  } as unknown as ProjectTeamTaskDetail;
}

/** Mirrors ProjectTeamService: approving starts the work; the card shows answered. */
async function answerDecision(input: ProjectTeamAnswerDecisionInput) {
  server.answers.push(input);
  const card = server.card!;
  if (input.answer === PLAN_APPROVAL_START) server.stage = "running";
  server.card = {
    ...card,
    item: { ...card.item, answer: input.answer, answeredAt: AT, answeredBy: "user" },
  };
  notify();
  return AsyncResult.success({ item: card.item });
}

/** Mirrors task_todo_set: a new spec version with the todo checked. */
function leadChecks(todoId: string) {
  const latest = server.versions.at(-1)!;
  server.versions = [
    ...server.versions,
    {
      version: latest.version + 1,
      spec: {
        ...latest.spec,
        todos: latest.spec.todos.map((todo) =>
          todo.id === todoId ? { ...todo, done: true } : todo,
        ),
      },
    },
  ];
  notify();
}

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useTaskDetail: (() => {
    useServerTick();
    return {
      data: detail(),
      dataUpdatedAt: 0,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh: () => undefined,
    };
  }) as never,
  useAnswerDecision: (() => (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision(input)) as never,
  useProjectManagerEntries: (() => {
    useServerTick();
    return [
      {
        environmentId: ENVIRONMENT_ID,
        summary: makeProjectManagerSummaryFixture({
          projectId: PROJECT_ID,
          taskKeyPrefix: "BU",
          tasks: [taskRef()],
        }),
      },
    ];
  }) as never,
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

const SUMMARY =
  "지금 플랜 카드는 **글 덩어리**라 읽기 힘들어. 끝나면 **요약 + todo 목록**이 보이고 승인 후엔 진행판이 돼.";

function makeSpec(): ProjectTaskSpec {
  return {
    ...emptyProjectTaskSpec("From BU-56."),
    summary: SUMMARY,
    goal: "The card shows the summary and a live todo list.",
    nonGoals: "No server changes.",
    todos: [
      { ...newProjectTaskTodo("t1", "Plan view logic"), doneWhen: "Unit tests pass" },
      {
        ...newProjectTaskTodo("t2", "Approval card"),
        doneWhen: "Journey test passes",
        dependsOn: ["t1"],
      },
      {
        ...newProjectTaskTodo("t3", "Phone screenshots"),
        doneWhen: "Screenshots in the PR",
        dependsOn: ["t1", "t2"],
      },
    ],
    flow: "flowchart TD\n  A[Card] --> B[Board]",
    prototype: "<!doctype html><p id='proto'>Prototype card</p>",
    criteria: [
      { id: "c1", text: "Card shows todos", provenBy: "journey test", evidence: "test passed" },
      { id: "c2", text: "Works on phone", provenBy: "screenshot", evidence: null },
    ],
    files: [
      {
        path: "apps/web/src/components/plan/PlanTodoList.tsx",
        change: "new",
        why: "The todo box",
        todos: ["t2"],
      },
      {
        path: "apps/web/src/components/chat/PlanApprovalCard.tsx",
        change: "changed",
        why: "New card shape",
        todos: ["t2", "t3"],
      },
    ],
  };
}

function makeCard(spec: ProjectTaskSpec): ProjectDecisionCard {
  return {
    taskNumber: 62,
    taskTitle: "Plan view",
    plan: approvalPlanOf(spec),
    item: {
      id: ProjectAttentionItemId.make("attention-plan"),
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      kind: "approval",
      question: "This task reshapes the plan card.",
      options: [PLAN_APPROVAL_START],
      answer: null,
      answeredAt: null,
      askerThreadId: ThreadId.make("lead-62"),
      batchId: ProjectAttentionBatchId.make("batch-1"),
      createdAt: AT,
      supersededAt: null,
      answeredBy: null,
      specVersion: 3,
      summary: null,
      verification: null,
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

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === name && element.offsetParent !== null,
  );
  if (match === undefined) throw new Error(`No visible "${name}" button`);
  return match;
}

const card = () => container.querySelector<HTMLElement>("[data-decision-card]")!;
const modal = () => document.querySelector<HTMLElement>("[data-plan-review]")!;
const rows = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>("[data-plan-todo]")];
const statuses = (scope: ParentNode) => rows(scope).map((row) => row.dataset.planTodoStatus);

/** Nothing in the card sticks out past its right edge. */
function expectInside(outer: HTMLElement, inner: HTMLElement) {
  const box = outer.getBoundingClientRect();
  const rect = inner.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
  expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
}

describe.each([
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
])("plan view on $name", ({ width, height }) => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, height);
    const spec = makeSpec();
    server.stage = "awaiting_approval";
    server.versions = [{ version: 3, spec }];
    server.card = makeCard(spec);
    server.answers = [];
    container = document.body.appendChild(document.createElement("div"));
    container.style.cssText = "padding: 12px; max-width: 760px;";
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows summary and todos on the card, then the same card tracks progress", async () => {
    await act(async () => root.render(<LiveCard />));
    const open = card();
    expect(open.dataset.decisionCardState).toBe("open");
    expect(open.querySelector("[data-plan-meta]")?.textContent).toBe("BU-62 · Plan approval · v3");
    expect(open.querySelector("[data-plan-title]")?.textContent).toBe("Plan view");
    // The summary in the lead's words, bold phrases kept; no Goal/Verification sections.
    const summary = open.querySelector<HTMLElement>("[data-plan-summary-text]")!;
    expect([...summary.querySelectorAll("strong")].map((bold) => bold.textContent)).toEqual([
      "글 덩어리",
      "요약 + todo 목록",
    ]);
    expect(open.querySelector("[data-plan-summary-section]")).toBeNull();
    // Todos: nothing spins before approval; each has its check line and dependency chip.
    expect(statuses(open)).toEqual(["todo", "todo", "todo"]);
    const [first, second, third] = rows(open);
    expect(first!.querySelector("[data-plan-todo-done-when]")?.textContent).toBe(
      "Done when: Unit tests pass",
    );
    expect(first!.querySelector("[data-plan-todo-deps]")).toBeNull();
    expect(second!.querySelector("[data-plan-todo-deps]")?.textContent).toBe("↳ after 1");
    expect(third!.querySelector("[data-plan-todo-deps]")?.textContent).toBe("↳ after 1, 2");
    expect(open.querySelector("[data-plan-progress]")?.textContent).toBe("3 steps · 0 done");
    for (const name of ["Approve", "View details"]) expectInside(open, button(name, open));
    for (const row of rows(open)) expectInside(open, row);

    await userEvent.click(button("Approve", open));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]!.answer).toBe(PLAN_APPROVAL_START);

    // The same card stays as a live board: the first ready step spins.
    await vi.waitFor(() => expect(card().dataset.decisionCardState).toBe("answered"));
    const board = card();
    expect(board.hasAttribute("data-plan-board")).toBe(true);
    expect(board.querySelector("[data-plan-meta]")?.textContent).toBe(
      "BU-62 · Approved and started · v3",
    );
    expect(board.querySelector("[data-plan-summary-text]")).not.toBeNull();
    expect(statuses(board)).toEqual(["current", "todo", "todo"]);
    expect(board.querySelector('[data-plan-todo-icon="current"] svg')).not.toBeNull();
    expect(() => button("Approve", board)).toThrow();

    // The lead checks off step 1: it ticks, and step 2 is now the current one.
    await act(async () => leadChecks("t1"));
    await vi.waitFor(() => expect(statuses(card())).toEqual(["done", "current", "todo"]));
    expect(card().querySelector("[data-plan-progress]")?.textContent).toBe("3 steps · 1 done");
    await act(async () => leadChecks("t2"));
    await act(async () => leadChecks("t3"));
    await vi.waitFor(() => expect(statuses(card())).toEqual(["done", "done", "done"]));
    expect(card().querySelector("[data-plan-progress]")?.textContent).toBe("3 steps · 3 done");

    // Once the task is done, the card stops reading live and says so.
    server.stage = "done";
    await act(async () => notify());
    await vi.waitFor(() =>
      expect(card().querySelector("[data-plan-progress]")?.textContent).toBe("Done"),
    );
    expect(rows(card())).toHaveLength(0);
  });

  it("opens the full plan from View details, with comments on the todos", async () => {
    await act(async () => root.render(<LiveCard />));
    await userEvent.click(button("View details", card()));
    await vi.waitFor(() => expect(modal()?.querySelector("[data-plan-files]")).not.toBeNull());
    const review = modal();

    // Summary, steps, end state + prototype, flow, criteria, breakdown and files, in order.
    const order = [
      "[data-plan-summary-text]",
      "[data-plan-todos]",
      '[data-plan-section="End result"]',
      "[data-plan-prototype]",
      '[data-plan-part="Flow"]',
      "[data-plan-criteria]",
      '[data-plan-part="Breakdown"]',
      "[data-plan-files]",
    ].map((selector) => {
      const element = review.querySelector(selector);
      expect(element, selector).not.toBeNull();
      return element!;
    });
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The prototype runs in a sandbox: no scripts, no same-origin access.
    const frame = review.querySelector<HTMLIFrameElement>("[data-plan-prototype] iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.srcdoc).toContain("Prototype card");
    expectInside(review, frame);
    // Flow and breakdown render as diagrams.
    await vi.waitFor(
      () => {
        expect(review.querySelector('[data-plan-part="Flow"] svg')).not.toBeNull();
        expect(review.querySelector('[data-plan-part="Breakdown"] svg')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    // Criteria: checked once proven, with how and the evidence.
    const criteria = [...review.querySelectorAll<HTMLElement>("[data-plan-criterion]")];
    expect(criteria.map((row) => row.querySelector("input")!.checked)).toEqual([true, false]);
    expect(criteria[0]!.textContent).toContain("Evidence: test passed");
    expect(criteria[1]!.textContent).toContain("Proven by: screenshot");

    // File tree: shared folders merge, folders fold, a file shows why and its steps.
    const tree = review.querySelector<HTMLElement>("[data-plan-files]")!;
    const folder = tree.querySelector<HTMLElement>('[data-plan-folder="apps/web/src/components"]')!;
    expect(folder.textContent).toBe("apps/web/src/components");
    await userEvent.click(
      tree.querySelector<HTMLElement>('[data-plan-file$="PlanApprovalCard.tsx"]')!,
    );
    const fileDetail = tree.querySelector<HTMLElement>("[data-plan-file-detail]")!;
    expect(fileDetail.textContent).toContain("New card shape");
    expect(fileDetail.textContent).toContain("Steps: 2, 3");
    await userEvent.click(folder);
    expect(tree.querySelector("[data-plan-file]")).toBeNull();
    await userEvent.click(folder);
    expect(tree.querySelectorAll("[data-plan-file]")).toHaveLength(2);

    // Comment on step 2 and on the summary, then request changes: both quotes go to the lead.
    for (const [name, text] of [
      ["Step 2", "Split this"],
      ["Summary", "Shorter"],
    ] as const) {
      const target = review.querySelector<HTMLElement>(`[data-plan-section="${name}"]`)!;
      target.scrollIntoView({ block: "center" });
      await userEvent.tripleClick(target);
      await userEvent.click(await vi.waitFor(() => button("Comment")));
      const input = await vi.waitFor(() => {
        const element = review.querySelector<HTMLTextAreaElement>(
          "[data-annotation-pill] textarea",
        );
        expect(element).not.toBeNull();
        return element!;
      });
      await userEvent.type(input, `${text}{Enter}`);
      await vi.waitFor(() => expect(review.querySelector("[data-annotation-pill]")).toBeNull());
    }
    await userEvent.click(button("Request changes", review));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    const answer = server.answers[0]!.answer;
    expect(answer).toContain("Approval card");
    expect(answer).toContain("Split this");
    expect(answer).toContain("Shorter");
  });
});
