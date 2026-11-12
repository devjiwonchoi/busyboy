import {
  EnvironmentId,
  PLAN_APPROVAL_START,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  type ProjectTaskReference,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamTaskDetail,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { emptyProjectTaskSpec, newProjectTaskTodo } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { longPressSelect, tap } from "../../test-touch-selection";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
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
  /** Every project's tasks, for the Structure section. */
  managers: [] as Array<{ environmentId: string; summary: unknown }>,
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
  useProjectManagerEntries: (() => server.managers) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => [ENVIRONMENT_ID]) as never,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: "project-1", environmentId: "environment-local", title: "BusyBoy" },
    { id: "site", environmentId: "environment-local", title: "Website" },
  ]) as never,
}));

// The chat sits inside the app's router; a plain link stands in for it here.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ params, to: _to, ...rest }: { params?: { taskId?: string }; to?: string }) => (
    <a href={`#${params?.taskId ?? ""}`} {...rest} />
  )) as never,
}));

function taskRef(id: string, number: number, title: string, extra: Partial<ProjectTaskReference>) {
  return {
    id: ProjectTaskId.make(id),
    number,
    parentTaskId: null,
    waitsOn: [],
    title,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: AT,
    ...extra,
  } satisfies ProjectTaskReference;
}

/**
 * BU-32 is part of BU-30, waits on BU-31 (open) and BU-29 (done), has two subtasks,
 * and blocks a task in another project.
 */
function makeManagers() {
  return [
    {
      environmentId: ENVIRONMENT_ID,
      summary: makeProjectManagerSummaryFixture({
        projectId: PROJECT_ID,
        taskKeyPrefix: "BU",
        tasks: [
          taskRef("task-29", 29, "Card styles", { stage: "done" }),
          taskRef("task-30", 30, "Plan approval rework", {}),
          taskRef("task-31", 31, "Card layout", {}),
          taskRef("task-32", 32, "Plan approval modal", {
            stage: "awaiting_approval",
            parentTaskId: ProjectTaskId.make("task-30"),
            waitsOn: [ProjectTaskId.make("task-31"), ProjectTaskId.make("task-29")],
          }),
          taskRef("task-33", 33, "Modal shell", {
            stage: "done",
            parentTaskId: TASK_ID,
          }),
          taskRef("task-34", 34, "Version picker", { stage: "inbox", parentTaskId: TASK_ID }),
        ],
      }),
    },
    {
      environmentId: ENVIRONMENT_ID,
      summary: makeProjectManagerSummaryFixture({
        projectId: ProjectId.make("site"),
        pmThreadId: ThreadId.make("pm-site"),
        taskKeyPrefix: "SI",
        tasks: [taskRef("site-4", 4, "Docs page", { waitsOn: [TASK_ID] })],
      }),
    },
  ];
}

function todo(id: string, text: string) {
  return newProjectTaskTodo(id, text);
}

function version(n: number, goal: string, todos: ReturnType<typeof todo>[]) {
  return {
    taskId: TASK_ID,
    version: n,
    spec: {
      ...emptyProjectTaskSpec(),
      background: "Plan approval was removed in #103.",
      goal,
      successCriteria: "- The user can approve from the **PM chat**.",
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
      iterateRound: 0,
      shipRound: 0,
      modelSteps: {},
      roleModels: {},
      review: null,
      ready: null,
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
    plan: null,
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
      summary: "- A card in the PM chat\n- It opens a review modal",
      verification: "- A journey test approves from the modal",
      details: null,
      senderRole: null,
      senderName: null,
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

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
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
  const card = container.querySelector<HTMLElement>('[data-decision-card-state="open"]')!;
  // An open approval is one message; the full plan opens from its details.
  expect(card.querySelector("[data-request-bubble]")).not.toBeNull();
  expect(card.textContent).not.toContain("BU-32");
  await userEvent.click(button("자세히 보기"));
  await userEvent.click(button("전체 플랜"));
  await vi.waitFor(() => expect(section("End result")).toBeTruthy());
}

/** The Comment button is the top element at its center and clears the selection. */
async function expectCommentButtonOnTop(selected: HTMLElement) {
  const comment = await vi.waitFor(() => button("Comment"));
  const box = comment.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  expect(comment.contains(hit)).toBe(true);
  // Opaque background: no alpha below 1 in rgba(…, a) or oklch(… / a).
  expect(getComputedStyle(comment).backgroundColor).not.toMatch(
    /(,|\/)\s*0?\.\d+\)$|(,|\/)\s*0\)$/,
  );
  // A triple click selects the whole section; the app trims the selection to its text.
  const text = document.createRange();
  text.selectNodeContents(selected);
  expect(box.bottom).toBeLessThanOrEqual(text.getBoundingClientRect().top);
  const body = modal().querySelector("[data-plan-body]")!.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(body.left);
  expect(box.right).toBeLessThanOrEqual(body.right);
}

function pin(number: number): HTMLElement | null {
  return modal().querySelector<HTMLElement>(`[data-annotation-pin="${number}"]`);
}

function pill(): HTMLElement | null {
  return modal().querySelector<HTMLElement>("[data-annotation-pill]");
}

/** The pill sits above its pin and fully inside the viewport. */
function expectPillAbovePin(number: number) {
  const box = pill()!.getBoundingClientRect();
  expect(box.bottom).toBeLessThanOrEqual(pin(number)!.getBoundingClientRect().top);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth);
}

function chipLabel(): string | undefined {
  return modal().querySelector("[data-annotations-chip]")?.textContent?.trim();
}

/** Selects a section, presses Comment and types into the new annotation's pill. */
async function commentOn(name: string, text: string) {
  await userEvent.tripleClick(section(name));
  await expectCommentButtonOnTop(section(name));
  await userEvent.click(button("Comment"));
  await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("new"));
  const input = pill()!.querySelector("textarea")!;
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.placeholder).toBe("Add an optional comment…");
  if (text) await userEvent.type(input, text);
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
    server.managers = [];
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  it("requests changes with an inline comment and an overall comment", async () => {
    await openReview();
    const review = modal();
    expect(review.textContent).toContain("BU-32");
    expect(review.textContent).toContain("Waiting for approval");
    expect(section("End result").textContent).toBe("Keep the cursor position steady after review.");
    // The card's Goal and Verification sit at the top, as markdown lists.
    const sections = [...review.querySelectorAll<HTMLElement>("[data-plan-summary-section]")];
    expect(sections.map((entry) => entry.dataset.planSummarySection)).toEqual([
      "Goal",
      "Verification",
    ]);
    expect(sections[0]!.querySelectorAll("li")).toHaveLength(2);
    expect(sections[1]!.querySelector("li")?.textContent?.trim()).toBe(
      "A journey test approves from the modal",
    );
    // Verification reads as a checklist.
    const check = sections[1]!.querySelector<HTMLInputElement>('li input[type="checkbox"]');
    expect(check?.checked).toBe(false);
    // Plan sections render as markdown too.
    expect(section("Success criteria").textContent?.trim()).toBe(
      "The user can approve from the PM chat.",
    );
    expect(section("Success criteria").querySelector("li strong")?.textContent).toBe("PM chat");
    expect(section("Non-goals").textContent).toBe("Changing how tasks are created.");
    expect(modal().querySelectorAll("[data-plan-todo]")).toHaveLength(2);
    // Full screen on phones, once the open animation settles.
    if (width < 768) {
      await vi.waitFor(() => {
        const rect = review.getBoundingClientRect();
        expect([rect.left, rect.top, rect.width, rect.height]).toEqual([0, 0, width, height]);
      });
    }

    // No comments column: the plan takes the full width.
    expect(review.querySelector("[data-plan-comments]")).toBeNull();
    expect(chipLabel()).toBeUndefined();
    // Nothing to send yet.
    expect(button("Request changes").disabled).toBe(true);

    // Comment on End result: a numbered pin, then the pill above it. Enter saves.
    await commentOn("End result", "Say which cursor.");
    await vi.waitFor(() => expect(pin(1)?.textContent).toBe("1"));
    await vi.waitFor(() => expectPillAbovePin(1));
    expect(CSS.highlights.get("t3-annotation")?.size).toBe(1);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(pill()).toBeNull());
    expect(chipLabel()).toBe("1 comment");

    // A second one, cancelled with Esc: its pin goes away and the dialog stays open.
    await commentOn("Non-goals", "Never mind");
    await vi.waitFor(() => expect(pin(2)).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(pin(2)).toBeNull());
    expect(document.querySelector("[data-plan-review]")).not.toBeNull();
    expect(chipLabel()).toBe("1 comment");

    // The pin reopens the comment for editing.
    await userEvent.click(pin(1)!);
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("edit"));
    expectPillAbovePin(1);
    const input = pill()!.querySelector("textarea")!;
    expect(input.value).toBe("Say which cursor.");
    // Focus lands at the end of the saved comment.
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(input.value.length);
    await userEvent.keyboard(" Text or mouse?");
    await userEvent.click(button("Save", pill()!));
    await vi.waitFor(() => expect(pill()).toBeNull());

    const overall = review.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Overall comment"]',
    )!;
    await userEvent.type(overall, "Looks close.");
    await vi.waitFor(() => expect(overall.value).toBe("Looks close."));
    await userEvent.click(button("Request changes"));

    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    const answer = server.answers[0]!;
    expect(answer.attentionItemId).toBe("attention-approval");
    expect(answer.answer).toContain("Request changes (review of spec v2)");
    expect(answer.answer).toContain("Looks close.");
    expect(answer.answer).toContain(
      '[End result] "Keep the cursor position steady after review." → Say which cursor. Text or mouse?',
    );
    expect(answer.answer).not.toContain("Never mind");
    await vi.waitFor(() => expect(document.querySelector("[data-plan-review]")).toBeNull());
    const answered = container.querySelector('[data-decision-card-state="answered"]')!;
    expect(answered.textContent).toContain("Changes requested");
  });

  it.runIf(width < 768)("comments on a touch selection", async () => {
    await openReview();
    await longPressSelect(section("End result"), "cursor", "steady");

    // Below the selection, clear of the end handle: the phone's own menu sits above it.
    const comment = await vi.waitFor(() => button("Comment"));
    const selected = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    expect(comment.getBoundingClientRect().top).toBeGreaterThanOrEqual(selected.bottom + 20);

    // The tap clears the selection before it lands; the button stays and takes it.
    await tap(comment);
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("new"));
    const input = pill()!.querySelector("textarea")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.type(input, "Which cursor?");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(chipLabel()).toBe("1 comment"));

    await userEvent.click(button("Request changes"));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]!.answer).toContain(
      '[End result] "cursor position steady" → Which cursor?',
    );
  });

  it("shows where the task sits: parent, blockers, blocked tasks and subtasks", async () => {
    server.managers = makeManagers();
    await openReview();
    const review = modal();
    // Linear's parent breadcrumb, above the title.
    const parent = review.querySelector<HTMLElement>("[data-task-parent]")!;
    expect(parent.textContent).toBe("Plan approval rework · BusyBoy");
    expect(parent.getAttribute("href")).toBe("#task-30");
    const title = review.querySelector<HTMLElement>("[data-plan-title]")!;
    expect(parent.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The relation lists, in Linear's order; each row is a status icon, key and title.
    const structure = review.querySelector<HTMLElement>("[data-task-structure]")!;
    const groups = [...structure.querySelectorAll<HTMLElement>("[data-relation-group]")];
    const rows = (group: HTMLElement) =>
      [...group.querySelectorAll("[data-related-task]")].map((row) =>
        row.getAttribute("data-related-task"),
      );
    expect(groups.map((group) => group.dataset.relationGroup)).toEqual([
      "subtasks",
      "blocked-by",
      "blocking",
      "related",
    ]);
    expect(groups[0]!.querySelector("h3")!.textContent).toContain("하위 태스크");
    expect(
      groups[0]!.querySelector("[data-subtask-progress]")!.getAttribute("data-subtask-progress"),
    ).toBe("1/2");
    expect(rows(groups[0]!)).toEqual(["BU-33", "BU-34"]);
    expect(rows(groups[1]!)).toEqual(["BU-31"]);
    // Blocks a task in another project.
    expect(rows(groups[2]!)).toEqual(["SI-4"]);
    // A finished blocker moves to Related.
    expect(rows(groups[3]!)).toEqual(["BU-29"]);
    const done = structure.querySelector<HTMLElement>('[data-related-task="BU-33"]')!;
    expect(done.dataset.taskStatus).toBe("done");
    expect(done.querySelector("a")!.getAttribute("href")).toBe("#task-33");
    // Every row fits the modal at this width.
    for (const row of structure.querySelectorAll<HTMLElement>("[data-related-task]")) {
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    }
  });

  it("shows the filled plan gates around Non-goals in gate order", async () => {
    const detail = makeDetail();
    const [first, last] = detail.versions;
    server.detail = {
      ...detail,
      versions: [
        first!,
        {
          ...last!,
          spec: { ...last!.spec, problem: "Approval is lost on scroll.", risks: "Focus traps." },
        },
      ],
    };
    await openReview();
    const order = [...modal().querySelectorAll<HTMLElement>("[data-plan-section]")].map(
      (element) => element.dataset.planSection,
    );
    expect(order.filter((name) => ["문제", "Non-goals", "위험"].includes(name!))).toEqual([
      "문제",
      "Non-goals",
      "위험",
    ]);
    expect(section("문제").textContent).toBe("Approval is lost on scroll.");
    expect(section("위험").textContent).toBe("Focus traps.");
    expect(modal().querySelector('[data-plan-section="왜"]')).toBeNull();
  });

  it("approves and starts", async () => {
    await openReview();
    expect(() => button("Approve only", modal())).toThrow();
    await userEvent.click(button("Approve", modal()));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    expect(server.answers[0]!.answer).toBe(PLAN_APPROVAL_START);
    await vi.waitFor(() => expect(document.querySelector("[data-plan-review]")).toBeNull());
    const answered = container.querySelector('[data-decision-card-state="answered"]')!;
    expect(answered.textContent).toContain("Approved and started");

    // The answered card still opens the plan, read-only.
    await userEvent.click(button("View plan"));
    await vi.waitFor(() => expect(section("End result")).toBeTruthy());
    expect(modal().textContent).toContain("Approved and started");
    expect(() => button("Approve", modal())).toThrow();
    expect(modal().querySelector('textarea[aria-label="Overall comment"]')).toBeNull();
  });

  it("approves with a comment, which the lead gets as a note", async () => {
    await openReview();
    await commentOn("End result", "");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(chipLabel()).toBe("1 comment"));
    // The chip lists it; picking the entry reopens its pill.
    await userEvent.click(modal().querySelector<HTMLElement>("[data-annotations-chip]")!);
    const list = await vi.waitFor(() => document.querySelector("[data-annotations-list]")!);
    expect(list.textContent).toContain("Keep the cursor position");
    await userEvent.click(list.querySelector("button")!);
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("edit"));
    const note = pill()!.querySelector("textarea")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(note));
    await userEvent.type(note, "Phones too.");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(button("Approve", modal()));
    await vi.waitFor(() => expect(server.answers).toHaveLength(1));
    const answer = server.answers[0]!.answer;
    expect(answer.split("\n")[0]).toBe(PLAN_APPROVAL_START);
    expect(answer).toContain(
      '[End result] "Keep the cursor position steady after review." → Phones too.',
    );
    await vi.waitFor(() => expect(document.querySelector("[data-plan-review]")).toBeNull());
    expect(container.querySelector('[data-decision-card-state="answered"]')?.textContent).toContain(
      "Approved and started",
    );
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
