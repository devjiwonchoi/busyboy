import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  derivePmAuthorHeaderMessageIds,
  derivePmSitrepReplies,
  pmEventLineText,
  pmSitrepSince,
  reusePmTimelineValues,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

const AT = "2026-11-04T10:00:00.000Z";
const SITREP_TEXT = `[Sitrep due] since ${AT}. Call team_status(since) and post a 3–6 line sitrep.`;

function chat(
  id: string,
  role: ChatMessage["role"],
  text: string,
  runId: string | null = null,
): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    runId: runId === null ? null : RunId.make(runId),
    streaming: false,
    createdAt: AT,
    updatedAt: AT,
  };
}

function entry(message: ChatMessage): TimelineEntry {
  return { id: `entry-${message.id}`, kind: "message", createdAt: AT, message };
}

describe("pmEventLineText", () => {
  const line = (id: string, text: string) => pmEventLineText({ id: MessageId.make(id), text });

  it("names sitrep requests and user-requested sitreps", () => {
    expect(line("project-team:sitrep:1", SITREP_TEXT)).toBe("Sitrep");
    expect(
      line(
        "project-team:sitrep:2",
        `${SITREP_TEXT}\nThe user asked for this sitrep; post it even if nothing changed.`,
      ),
    ).toBe("Sitrep requested");
  });

  it("names context compaction only for the project-team compact message", () => {
    expect(line("project-team:compact:1", "/compact")).toBe("Tidying up context · notes kept");
    expect(line("other", "/compact")).toBe("/compact");
  });

  it("names delegated completion wakes", () => {
    expect(
      line(
        "m",
        "Delegated task task_abc reached a terminal state. Use task_status with taskId task_abc to read the result.",
      ),
    ).toBe("Task finished");
    expect(line("m", "Delegated task #6 reached a terminal state. Use task_status.")).toBe(
      "Task #6 finished",
    );
    expect(
      line(
        "m",
        "Delegated tasks a, b reached terminal states. Use task_status with each taskId to read the results.",
      ),
    ).toBe("Task finished");
  });

  it("uses the first line and drops the team_status hint", () => {
    expect(line("m", "1 task looks stalled: #4. Check team_status.")).toBe(
      "1 task looks stalled: #4",
    );
    expect(line("m", "#6 done · #7 is next in the inbox\nmore detail")).toBe(
      "#6 done · #7 is next in the inbox",
    );
    const long = line("m", "x".repeat(300));
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("pmSitrepSince", () => {
  it("reads the ISO instant from the request text", () => {
    expect(pmSitrepSince(SITREP_TEXT)).toBe(AT);
    expect(pmSitrepSince("[Sitrep due] since nonsense. Call")).toBeNull();
    expect(pmSitrepSince("hello")).toBeNull();
  });
});

describe("derivePmSitrepReplies", () => {
  it("marks the final assistant message of the run a sitrep request started", () => {
    const replies = derivePmSitrepReplies([
      entry(chat("u-1", "user", "hi", "run-1")),
      entry(chat("a-1", "assistant", "hello", "run-1")),
      entry(chat("project-team:sitrep:s1", "user", SITREP_TEXT, "run-2")),
      entry(chat("a-2", "assistant", "checking", "run-2")),
      entry(chat("a-3", "assistant", "Sitrep body", "run-2")),
      entry(chat("u-2", "user", "thanks", "run-3")),
      entry(chat("a-4", "assistant", "np", "run-3")),
    ]);
    expect([...replies.entries()]).toEqual([[MessageId.make("a-3"), { since: AT }]]);
  });

  it("falls back to ordering for runless messages", () => {
    const replies = derivePmSitrepReplies([
      entry(chat("project-team:sitrep:s1", "user", "[Sitrep due]")),
      entry(chat("a-1", "assistant", "first")),
      entry(chat("a-2", "assistant", "Sitrep body")),
      entry(chat("u-1", "user", "next")),
      entry(chat("a-3", "assistant", "reply")),
    ]);
    expect([...replies.entries()]).toEqual([[MessageId.make("a-2"), { since: null }]]);
  });

  it("ignores runs not started by a sitrep request", () => {
    expect(
      derivePmSitrepReplies([
        entry(chat("u-1", "user", SITREP_TEXT, "run-1")),
        entry(chat("a-1", "assistant", "hello", "run-1")),
      ]).size,
    ).toBe(0);
  });
});

describe("derivePmAuthorHeaderMessageIds", () => {
  it("picks the first visible assistant row after each user row", () => {
    const row = (message: ChatMessage) => ({ kind: "message", id: message.id, message });
    const rows = [
      row(chat("a-0", "assistant", "intro")),
      row(chat("u-1", "user", "hi")),
      { kind: "work", id: "w" },
      row(chat("a-1", "assistant", "one")),
      row(chat("a-2", "assistant", "two")),
      row(chat("u-2", "user", "again")),
      row(chat("a-3", "assistant", "three")),
    ] as unknown as MessagesTimelineRow[];
    expect([...derivePmAuthorHeaderMessageIds(rows)]).toEqual(["a-0", "a-1", "a-3"]);
  });
});

describe("reusePmTimelineValues", () => {
  const values = (ids: string[], replies: Array<[string, string | null]>, name = "Remy") => ({
    personaKey: JSON.stringify([name, { kind: "emoji", emoji: "🦝" }]),
    authorHeaderMessageIds: new Set(ids.map((id) => MessageId.make(id))),
    sitrepReplies: new Map(replies.map(([id, since]) => [MessageId.make(id), { since }] as const)),
  });

  it("keeps the previous value while a stream event leaves the content unchanged", () => {
    const previous = values(["a-1"], [["a-2", AT]]);
    expect(reusePmTimelineValues(previous, values(["a-1"], [["a-2", AT]]))).toBe(previous);
  });

  it("drops the previous value when a header, sitrep, or persona changes", () => {
    const previous = values(["a-1"], [["a-2", AT]]);
    expect(reusePmTimelineValues(null, previous)).toBeNull();
    expect(reusePmTimelineValues(previous, values(["a-1", "a-3"], [["a-2", AT]]))).toBeNull();
    expect(reusePmTimelineValues(previous, values(["a-1"], [["a-2", null]]))).toBeNull();
    expect(reusePmTimelineValues(previous, values(["a-1"], [["a-3", AT]]))).toBeNull();
    expect(reusePmTimelineValues(previous, values(["a-1"], [["a-2", AT]], "Juno"))).toBeNull();
  });
});
