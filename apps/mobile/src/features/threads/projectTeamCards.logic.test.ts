import {
  type ProjectDecisionCard,
  type ProjectTeamAttentionSummary,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { cardOptionLabel, openTeamCardsForThread, requestTodoRows } from "./projectTeamCards.logic";

const PM = ThreadId.make("pm");
const DIRECTOR = ThreadId.make("director");
function card(id: string, overrides: Partial<ProjectDecisionCard["item"]>): ProjectDecisionCard {
  return {
    taskNumber: null,
    taskTitle: "BU-129 목표 그래프 (후속)",
    plan: null,
    item: {
      id: id as never,
      projectId: "project" as never,
      taskId: "task" as never,
      kind: "approval",
      question: "목표 그래프 플랜 승인 부탁드려요.",
      options: [],
      answer: null,
      answeredAt: null,
      askerThreadId: PM,
      batchId: "batch" as never,
      createdAt: "2026-11-10T03:00:00.000Z",
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
      senderRole: null,
      senderName: null,
      details: null,
      ...overrides,
    },
  };
}
const summary = {
  projectId: "project",
  pmThreadId: PM,
  tasks: [{ id: "task", leadThreadId: "lead" }],
  decisionCards: [
    card("plan", {}),
    card("answered", { answeredAt: "now" }),
    card("old", { supersededAt: "now" }),
    card("decision", { kind: "decision", createdAt: "2026-11-10T02:00:00.000Z" }),
  ],
} as unknown as ProjectTeamAttentionSummary;

describe("projectTeamCards logic", () => {
  it("includes open plan approvals in chronological order and excludes closed requests", () => {
    expect(
      openTeamCardsForThread([summary], PM, () => "busyboy").map((entry) => entry.card.item.id),
    ).toEqual(["decision", "plan"]);
    expect(openTeamCardsForThread([summary], ThreadId.make("other"), () => "busyboy")).toEqual([]);
  });
  it("falls back to lead when present, otherwise PM, without task keys", () => {
    expect(openTeamCardsForThread([summary], PM, () => "busyboy")[0]?.sender).toBe(
      "busyboy · 목표 그래프 리드",
    );
    expect(
      openTeamCardsForThread([{ ...summary, tasks: [] }], PM, () => "busyboy")[0]?.sender,
    ).toBe("busyboy · PM");
  });
  it("honors explicit sender roles and maps Director requests to the task project", () => {
    const director = {
      ...summary,
      projectId: "director" as never,
      pmThreadId: DIRECTOR,
      kind: "director" as const,
      tasks: [],
      decisionCards: [card("director", { senderRole: "director", projectId: "director" as never })],
    };
    const entries = openTeamCardsForThread([summary, director], DIRECTOR, (id) =>
      id === summary.projectId ? "busyboy" : "Director project",
    );
    expect(entries).toHaveLength(3);
    expect(entries[2]?.sender).toBe("Director");
    expect(entries[2]?.header).toContain("busyboy");
    // Only the request's own PM chat can tie a reply to it.
    expect(entries.map((entry) => entry.replyable)).toEqual([false, false, true]);
    expect(openTeamCardsForThread([summary], PM, () => "busyboy")[0]?.replyable).toBe(true);
  });
  it("separates visible todo titles from criteria and numbered dependency details", () => {
    const plan = {
      ...card("plan", {}),
      plan: {
        summary: "",
        subtasks: [],
        todos: [
          { id: "one", text: "배치 바꾸기", done: true, doneWhen: "위치가 같아요", dependsOn: [] },
          {
            id: "two",
            text: "모바일 확인",
            done: false,
            doneWhen: "폰에서 보여요",
            dependsOn: ["one", "missing"],
          },
        ],
      },
    };
    expect(requestTodoRows(plan)).toEqual([
      { id: "one", text: "배치 바꾸기", done: true, detail: "위치가 같아요", number: 1 },
      { id: "two", text: "모바일 확인", done: false, detail: "폰에서 보여요 · 1 다음", number: 2 },
    ]);
    expect(requestTodoRows(card("empty", {}))).toEqual([]);
    // Without a pinned plan, the asked spec version's todos fill in, like web.
    expect(requestTodoRows(card("unpinned", {}), plan.plan!.todos).map((row) => row.text)).toEqual([
      "배치 바꾸기",
      "모바일 확인",
    ]);
  });
  it("shortens legacy action labels while preserving ordinary labels", () => {
    expect(cardOptionLabel("진행: 시도 (Recommended)")).toBe("진행");
    expect(cardOptionLabel("가드 — 오늘 배포 (추천)")).toBe("가드");
    expect(cardOptionLabel("직접 실행")).toBe("직접 실행");
  });
});
