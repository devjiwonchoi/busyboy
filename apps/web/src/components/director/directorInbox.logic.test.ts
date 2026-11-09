import { describe, expect, it } from "vite-plus/test";
import type { ProjectDecisionCard } from "@t3tools/contracts";
import { makeProjectManagerSummaryFixture } from "~/test-fixtures";
import { directorInbox } from "./directorInbox.logic";

function card(id: string, createdAt: string, answeredAt: string | null): ProjectDecisionCard {
  return {
    taskNumber: 1,
    taskTitle: "결정",
    proposal: null,
    plan: null,
    item: {
      id: id as never,
      projectId: "p" as never,
      taskId: "t" as never,
      kind: "decision",
      question: "어떻게 할까요?",
      options: [],
      answer: null,
      answeredAt,
      supersededAt: null,
      createdAt,
      askerThreadId: "pm" as never,
      batchId: "batch" as never,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}
const entry = (id: string, cards: ProjectDecisionCard[]) => ({
  environmentId: "env" as never,
  summary: makeProjectManagerSummaryFixture({ projectId: id as never, decisionCards: cards }),
});

describe("directorInbox", () => {
  it("groups projects by their oldest open card and counts waiting threads", () => {
    const later = card("later", "2026-11-09T02:00:00Z", null);
    const earlier = card("earlier", "2026-11-09T01:00:00Z", null);
    const closed = card("closed", "2026-11-08T01:00:00Z", "2026-11-08T02:00:00Z");
    const superseded = {
      ...closed,
      item: { ...closed.item, answeredAt: null, supersededAt: closed.item.createdAt },
    };
    const b = entry("b", [later]);
    b.summary = {
      ...b.summary,
      waitingThreads: [{ threadId: "thread" as never, title: "답변", kind: "question" }],
    };
    const result = directorInbox([b, entry("a", [later, closed, superseded, earlier])]);
    expect(result.groups.map((group) => group.projectId)).toEqual(["a", "b"]);
    expect(result.groups[0]?.cards.map((item) => item.item.id)).toEqual(["earlier", "later"]);
    expect(result.groups[1]?.total).toBe(2);
    expect(result.total).toBe(4);
  });

  it("puts thread-only groups last and keeps equal timestamps stable, including the Director", () => {
    const first = entry("first", []);
    first.summary = {
      ...first.summary,
      kind: "director",
      waitingThreads: [{ threadId: "thread" as never, title: "답변", kind: "plan" }],
    };
    const open = card("open", "2026-11-09T01:00:00Z", null);
    const result = directorInbox([first, entry("b", [open]), entry("a", [open])]);
    expect(result.groups.map((group) => group.projectId)).toEqual(["b", "a", "first"]);
    expect(result.groups[2]?.isDirector).toBe(true);
    expect(result.groups[2]?.oldestAt).toBeNull();
  });

  it("omits empty projects and an empty inbox", () => {
    expect(directorInbox([])).toEqual({ groups: [], total: 0 });
    expect(directorInbox([entry("empty", [])])).toEqual({ groups: [], total: 0 });
  });
});
