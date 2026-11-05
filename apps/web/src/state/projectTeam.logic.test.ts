import { ThreadId, type ProjectManagerPresence } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProjectManagerPresence,
  resolveProjectManagerStatus,
  taskReferencesForThread,
} from "./projectTeam.logic";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function input(presence: Partial<ProjectManagerPresence> = {}, openCount = 0) {
  return {
    openCount,
    presence: {
      running: 0,
      waitingOnUser: 0,
      stalled: 0,
      inbox: 0,
      nextSitrepAt: null,
      lastAction: null,
      ...presence,
    } as ProjectManagerPresence,
  };
}

describe("formatProjectManagerPresence", () => {
  it("joins counts with the last action and its age", () => {
    expect(
      formatProjectManagerPresence(
        input({
          running: 2,
          waitingOnUser: 1,
          lastAction: { text: "nudged #5", at: "2026-11-04T11:58:00.000Z" as never },
        }),
        NOW,
      ),
    ).toBe("2 working · 1 needs you · last: nudged #5 · 2m ago");
  });

  it("lists stalled and inbox tasks, and falls back to open attention for needs you", () => {
    expect(formatProjectManagerPresence(input({ stalled: 1, inbox: 3 }, 2), NOW)).toBe(
      "2 needs you · 1 stalled · 3 in inbox",
    );
  });

  it("says Idle with the next sitrep when nothing is going on", () => {
    expect(
      formatProjectManagerPresence(
        input({ nextSitrepAt: "2026-11-04T12:15:00.000Z" as never }),
        NOW,
      ),
    ).toBe("Idle · next sitrep in 15m");
    expect(formatProjectManagerPresence(input(), NOW)).toBe("Idle");
  });
});

describe("resolveProjectManagerStatus", () => {
  it("prefers needs you, then working, then idle", () => {
    expect(
      resolveProjectManagerStatus({ summary: input({ running: 1 }, 1), pmThreadWorking: true }),
    ).toBe("needs-you");
    expect(resolveProjectManagerStatus({ summary: input(), pmThreadWorking: true })).toBe(
      "working",
    );
    expect(
      resolveProjectManagerStatus({ summary: input({ running: 1 }), pmThreadWorking: false }),
    ).toBe("working");
    expect(resolveProjectManagerStatus({ summary: input(), pmThreadWorking: false })).toBe("idle");
  });
});

describe("taskReferencesForThread", () => {
  const summary = {
    pmThreadId: ThreadId.make("pm"),
    tasks: [
      {
        id: "task-1" as never,
        number: 1,
        parentTaskId: null,
        title: "Sidebar",
        stage: "done" as const,
        leadThreadId: ThreadId.make("lead-1"),
        prUrl: null,
        lastOutcome: null,
      },
      {
        id: "task-2" as never,
        number: 2,
        parentTaskId: null,
        title: "Docs",
        stage: "inbox" as const,
        leadThreadId: null,
        prUrl: null,
        lastOutcome: null,
      },
    ],
  };

  it("resolves numbers for the PM and its task leads", () => {
    expect(taskReferencesForThread(summary, ThreadId.make("pm"))?.get(2)?.title).toBe("Docs");
    expect(taskReferencesForThread(summary, ThreadId.make("lead-1"))?.get(1)?.title).toBe(
      "Sidebar",
    );
  });

  it("resolves nothing for other threads or projects without a PM", () => {
    expect(taskReferencesForThread(summary, ThreadId.make("other"))).toBeNull();
    expect(taskReferencesForThread(null, ThreadId.make("pm"))).toBeNull();
  });
});
