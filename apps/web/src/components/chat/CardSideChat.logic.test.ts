import { formatLeadQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectLeadQuestionThread, type LeadThreadMessage } from "./CardSideChat.logic";

const message = (
  id: string,
  role: LeadThreadMessage["role"],
  text: string,
  streaming = false,
): LeadThreadMessage => ({ id, role, text, streaming });

const ask = (id: string, cardId: string, question: string) =>
  message(
    id,
    "user",
    formatLeadQuestion({ cardId, cardLabel: "결정 · BU-7 Fix", question, quotes: [] }),
  );

describe("selectLeadQuestionThread", () => {
  it("keeps this card's questions and the lead's marked replies to them", () => {
    const entries = selectLeadQuestionThread(
      [
        message("m1", "user", "Start the task."),
        message("m2", "assistant", "Planning now."),
        ask("q1", "card-a", "왜요?"),
        message("a1", "assistant", "[답변] 오늘 고쳐야 해서요."),
        // The lead carries on with its work after answering.
        message("w1", "assistant", "Running the tests now."),
        message("m3", "user", "[User answer via BusyBoy] Approve"),
        message("w2", "assistant", "Starting."),
        ask("q2", "card-a", "얼마나 걸려요?"),
        message("a2", "assistant", "[답변]\n<!-- card:card-a -->\n하루요", true),
      ],
      "card-a",
    );
    expect(entries).toEqual([
      { kind: "question", id: "q1", quotes: [], question: "왜요?" },
      { kind: "answer", id: "a1", text: "오늘 고쳐야 해서요.", streaming: false },
      { kind: "question", id: "q2", quotes: [], question: "얼마나 걸려요?" },
      { kind: "answer", id: "a2", text: "하루요", streaming: true },
    ]);
  });

  it("matches a reply to the card it names, even out of order", () => {
    const messages = [
      ask("q1", "card-a", "A?"),
      ask("q2", "card-b", "B?"),
      message("a2", "assistant", "[답변]\n<!-- card:card-b -->\nB요."),
      message("a1", "assistant", "[답변]\n<!-- card:card-a -->\nA요."),
    ];
    expect(selectLeadQuestionThread(messages, "card-a")).toEqual([
      { kind: "question", id: "q1", quotes: [], question: "A?" },
      { kind: "answer", id: "a1", text: "A요.", streaming: false },
    ]);
    expect(selectLeadQuestionThread(messages, "card-b").at(-1)).toEqual({
      kind: "answer",
      id: "a2",
      text: "B요.",
      streaming: false,
    });
  });

  it("holds a streaming reply until its card line is complete", () => {
    const messages = [
      ask("q1", "card-a", "A?"),
      ask("q2", "card-b", "B?"),
      message("a2", "assistant", "[답변]\n<!-- card:car", true),
    ];
    expect(selectLeadQuestionThread(messages, "card-a")).toHaveLength(1);
    expect(selectLeadQuestionThread(messages, "card-b")).toHaveLength(1);
  });

  it("leaves out other cards' questions and their answers", () => {
    const messages = [
      ask("q1", "card-old", "예전 질문"),
      ask("q2", "card-new", "새 질문"),
      message("a1", "assistant", "[답변] 예전 답"),
      message("a2", "assistant", "[답변] 새 답"),
    ];
    expect(selectLeadQuestionThread(messages, "card-new")).toEqual([
      { kind: "question", id: "q2", quotes: [], question: "새 질문" },
      { kind: "answer", id: "a2", text: "새 답", streaming: false },
    ]);
  });
});
