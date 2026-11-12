import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { linkThread, toAsk, type AskSource } from "./asks.ts";

const threadId = ThreadId.make("thread-lead-1");
const questions: AskSource["questions"] = [
  {
    id: "q1",
    header: "모바일 알림",
    question: "이 끝 상태로 갈까요?",
    options: [
      { label: "합의 (추천)", description: "그대로 진행" },
      { label: "고칠래", description: "기준을 바꿈" },
    ],
  },
];

const source = (request: Partial<AskSource["request"]>): AskSource => ({
  threadId,
  request: {
    id: RuntimeRequestId.make("request-1"),
    kind: "user_input",
    status: "pending",
    resolvedAt: null,
    ...request,
  },
  questions,
});

describe("question tool calls as action cards", () => {
  it("makes an unanswered card from a pending question", () => {
    expect(toAsk(source({}))).toEqual({
      id: "request-1",
      threadId,
      kind: "question",
      question: "이 끝 상태로 갈까요?",
      sub: "모바일 알림",
      options: [
        { key: "A", label: "합의 (추천)", recommended: true },
        { key: "B", label: "고칠래", recommended: false },
      ],
      answer: null,
    });
  });

  it("fills the chosen answer and its time once answered", () => {
    const resolvedAt = DateTime.makeUnsafe("2026-11-12T10:00:00.000Z");
    expect(
      toAsk(source({ status: "resolved", resolvedAt, answers: { q1: "합의 (추천)" } }))?.answer,
    ).toEqual({ values: ["합의 (추천)"], at: "2026-11-12T10:00:00.000Z" });
    expect(
      toAsk(source({ status: "resolved", resolvedAt, answers: { q1: { answers: ["고칠래"] } } }))
        ?.answer?.values,
    ).toEqual(["고칠래"]);
  });

  it("makes no card for other requests or questions nobody can answer anymore", () => {
    expect(toAsk(source({ kind: "command" }))).toBeNull();
    expect(toAsk(source({ status: "expired" }))).toBeNull();
    expect(toAsk(source({ status: "cancelled" }))).toBeNull();
  });
});

describe("linking a thread's questions to a node", () => {
  const records = [
    { nodeId: "busyboy/clean-room", dirName: "clean-room", statusText: "- Owning chat: other" },
    {
      nodeId: "busyboy/mobile-notify",
      dirName: "mobile-notify",
      statusText: "- Owning chat: thread-lead-1 (2026-11-12)",
    },
    { nodeId: "busyboy/thread-lead-2", dirName: "thread-lead-2", statusText: null },
  ];

  it("links by the thread named in STATUS.md or by the folder name", () => {
    expect(linkThread(threadId, records)).toBe("busyboy/mobile-notify");
    expect(linkThread(ThreadId.make("thread-lead-2"), records)).toBe("busyboy/thread-lead-2");
  });

  it("leaves a thread no record names unlinked", () => {
    expect(linkThread(ThreadId.make("thread-elsewhere"), records)).toBeNull();
  });
});
