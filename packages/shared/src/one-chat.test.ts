import {
  PLAN_APPROVAL_START,
  type ProjectDecisionCard,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildActionCards,
  buildWorkItems,
  isSideChatCommand,
  isToastVisible,
  mentionQueryAt,
  type OneChatProject,
  projectMentionStatus,
  quoteForComposer,
  resultCardId,
  resultFixMessage,
  resultMergeRequestMessage,
  workCounts,
} from "./one-chat.js";

// Only the fields this pure module reads matter to these fixtures.
const task = (id: string, extra: Partial<ProjectTaskReference> = {}): ProjectTaskReference =>
  ({
    id,
    number: 1,
    parentTaskId: null,
    waitsOn: [],
    title: `Task ${id}`,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    updatedAt: "2026-11-12T10:00:00.000Z",
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    checks: null,
    ...extra,
  }) as ProjectTaskReference;

const card = (
  id: string,
  taskId: string | null,
  extra: Partial<ProjectDecisionCard["item"]> = {},
): ProjectDecisionCard =>
  ({
    item: {
      id,
      projectId: "p1",
      taskId,
      kind: "decision",
      question: "Which way should we go?\n\nOne line of context.",
      options: ["A: faster (Recommended)", "B: slower"],
      answer: null,
      answeredAt: null,
      supersededAt: null,
      createdAt: "2026-11-12T09:00:00.000Z",
      summary: null,
      verification: null,
      details: null,
      ...extra,
    },
    taskNumber: 1,
    taskTitle: `Task ${taskId}`,
    plan: null,
  }) as unknown as ProjectDecisionCard;

const project = (
  projectId: string,
  name: string,
  tasks: ProjectTaskReference[],
  decisionCards: ProjectDecisionCard[] = [],
  extra: Partial<ProjectTeamAttentionSummary> = {},
): OneChatProject => ({
  projectId,
  name,
  summary: { projectId, tasks, decisionCards, ...extra } as ProjectTeamAttentionSummary,
});

describe("buildWorkItems", () => {
  it("lists work waiting on the user before running work and skips finished tasks", () => {
    const items = buildWorkItems([
      project(
        "p1",
        "busyboy",
        [
          task("run"),
          task("ask", { stage: "running" }),
          task("done", { stage: "done" }),
          task("todo", { stage: "inbox" }),
        ],
        [card("c1", "ask")],
      ),
    ]);
    expect(items.map((item) => [item.taskId, item.state])).toEqual([
      ["ask", "waiting_on_me"],
      ["run", "running"],
    ]);
    expect(items[0]!.cardId).toBe("c1");
  });

  it("puts failures and stalls into waiting on me instead of counting them apart", () => {
    const items = buildWorkItems([
      project("p1", "busyboy", [
        task("failed", { lastOutcome: "failed" }),
        task("stalled", { lastOutcome: "stalled" }),
        task("blocked", { stage: "blocked" }),
      ]),
    ]);
    expect(items.every((item) => item.state === "waiting_on_me")).toBe(true);
    expect(items[0]!.statusLabel).toBe("Stuck");
  });

  it("waits on the user for a ready task in review and points at its result card", () => {
    const [item] = buildWorkItems([
      project("p1", "busyboy", [task("t1", { stage: "in_review", ready: true })]),
    ]);
    expect(item!.state).toBe("waiting_on_me");
    expect(item!.cardId).toBe(resultCardId("t1"));
    expect(item!.statusLabel).toBe("Waiting for result check");
  });

  it("counts proven criteria and links children and waits", () => {
    const [parent] = buildWorkItems([
      project("p1", "busyboy", [
        task("parent", {
          waitsOn: ["other" as never],
          checks: [
            { text: "a", passed: true },
            { text: "b", passed: false },
            { text: "c", passed: false },
          ],
        }),
        task("child", { parentTaskId: "parent" as never, stage: "inbox" }),
      ]),
    ]);
    expect(parent!.statusLabel).toBe("1 of 3 proven");
    expect(parent!.childIds).toEqual(["child"]);
    expect(parent!.waitsOnIds).toEqual(["other"]);
  });

  it("ignores snoozed and answered cards and the Director project", () => {
    const items = buildWorkItems([
      project(
        "p1",
        "busyboy",
        [task("t1")],
        [
          card("snoozed", "t1", { snoozedAt: "2026-11-12T09:30:00.000Z" }),
          card("answered", "t1", { answer: "A: faster (Recommended)" }),
        ],
      ),
      project("dir", "Director", [task("d1")], [], { kind: "director" }),
    ]);
    expect(items.map((item) => [item.taskId, item.state])).toEqual([["t1", "running"]]);
  });
});

describe("workCounts", () => {
  it("hides the toast only when nothing waits and nothing runs", () => {
    expect(isToastVisible(workCounts([]))).toBe(false);
    const items = buildWorkItems([project("p1", "busyboy", [task("t1")])]);
    expect(workCounts(items)).toEqual({ waitingOnMe: 0, running: 1 });
    expect(isToastVisible(workCounts(items))).toBe(true);
  });
});

describe("buildActionCards", () => {
  it("shapes a decision card as one question, one gray line and options with one recommended", () => {
    const [actionCard] = buildActionCards([
      project("p1", "busyboy", [task("t1")], [card("c1", "t1")]),
    ]);
    expect(actionCard).toMatchObject({
      kind: "decision",
      question: "Which way should we go?",
      subline: "One line of context.",
      projectName: "busyboy",
      answered: null,
    });
    expect(actionCard!.options).toEqual([
      { value: "A: faster (Recommended)", label: "A", recommended: true },
      { value: "B: slower", label: "B", recommended: false },
    ]);
  });

  it("marks the first option recommended when the card names none", () => {
    const [actionCard] = buildActionCards([
      project("p1", "busyboy", [task("t1")], [card("c1", "t1", { options: ["Yes", "No"] })]),
    ]);
    expect(actionCard!.options.map((option) => option.recommended)).toEqual([true, false]);
  });

  it("keeps only the picked option once answered", () => {
    const [actionCard] = buildActionCards([
      project(
        "p1",
        "busyboy",
        [task("t1")],
        [card("c1", "t1", { answer: "B: slower", answeredAt: "2026-11-12T09:10:00.000Z" })],
      ),
    ]);
    expect(actionCard!.answered).toEqual({ label: "B", at: "2026-11-12T09:10:00.000Z" });
  });

  it("gives plan cards agree and change options and the task's criteria", () => {
    const [actionCard] = buildActionCards([
      project(
        "p1",
        "busyboy",
        [task("t1", { checks: [{ text: "Alert within a minute", passed: false }] })],
        [card("c1", "t1", { kind: "approval", options: [], summary: "Purpose" })],
      ),
    ]);
    expect(actionCard!.kind).toBe("plan");
    expect(actionCard!.options[0]).toEqual({
      value: PLAN_APPROVAL_START,
      label: "Agree",
      recommended: true,
    });
    expect(actionCard!.criteria).toEqual(["Alert within a minute"]);
    expect(actionCard!.goal).toBe("Purpose");
  });

  it("shows an approved plan as agreed", () => {
    const [actionCard] = buildActionCards([
      project(
        "p1",
        "busyboy",
        [task("t1")],
        [card("c1", "t1", { kind: "approval", options: [], answer: PLAN_APPROVAL_START })],
      ),
    ]);
    expect(actionCard!.answered?.label).toBe("Agree");
  });

  it("makes a result card for a ready task and folds it once the task is done", () => {
    const ready = task("t1", {
      stage: "in_review",
      ready: true,
      prUrl: "https://github.com/o/r/pull/1",
      checks: [
        { text: "a", passed: true },
        { text: "b", passed: true },
      ],
    });
    const [open] = buildActionCards([project("p1", "busyboy", [ready])]);
    expect(open).toMatchObject({
      id: resultCardId("t1"),
      kind: "result",
      question: "Task t1: check the result?",
      subline: "2 of 2 criteria proven · PR open",
      answered: null,
      attentionItemId: null,
    });
    expect(open!.options.find((option) => option.recommended)?.label).toBe("Looks good, merge");

    const [folded] = buildActionCards([project("p1", "busyboy", [{ ...ready, stage: "done" }])]);
    expect(folded!.answered?.label).toBe("Looks good, merge");
  });

  it("drops superseded and snoozed cards and orders the rest oldest first", () => {
    const cards = buildActionCards([
      project(
        "p1",
        "busyboy",
        [task("t1")],
        [
          card("late", "t1", { createdAt: "2026-11-12T11:00:00.000Z" }),
          card("gone", "t1", { supersededAt: "2026-11-12T10:00:00.000Z" }),
          card("aside", "t1", { snoozedAt: "2026-11-12T10:00:00.000Z" }),
          card("early", "t1", { createdAt: "2026-11-12T08:00:00.000Z" }),
        ],
      ),
    ]);
    expect(cards.map((actionCard) => actionCard.id)).toEqual(["early", "late"]);
  });
});

describe("projectMentionStatus", () => {
  it("labels each project with what waits and what runs, or Quiet", () => {
    const statuses = projectMentionStatus([
      project("p1", "busyboy", [task("a"), task("b")], [card("c1", "a")]),
      project("p2", "skills", [task("c")]),
      project("p3", "blog", []),
    ]);
    expect(statuses.map((status) => status.label)).toEqual([
      "Waiting on you 1 · Running 1",
      "Running 1",
      "Quiet",
    ]);
  });
});

describe("messages and composer helpers", () => {
  const ready = buildActionCards([
    project("p1", "my app", [task("t1", { stage: "in_review", ready: true, title: "Alerts" })]),
  ])[0]!;

  it("asks the Director to merge instead of merging", () => {
    expect(resultMergeRequestMessage(ready)).toBe("@my-app Alerts: I checked the result. Please merge it.");
    expect(resultFixMessage(ready)).toBe("@my-app Alerts: please fix ");
  });

  it("quotes a side chat reply line by line", () => {
    expect(quoteForComposer("first line\nsecond line")).toBe("> first line\n> second line\n\n");
  });

  it("finds the @ query at the caret", () => {
    expect(mentionQueryAt("hi @bu", 6)).toEqual({ start: 3, query: "bu" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("mail@x", 6)).toBeNull();
    expect(mentionQueryAt("@busyboy done", 13)).toBeNull();
  });

  it("recognizes /side", () => {
    expect(isSideChatCommand("/side")).toBe(true);
    expect(isSideChatCommand(" /side ")).toBe(true);
    expect(isSideChatCommand("/sidebar")).toBe(false);
  });
});
