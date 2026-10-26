import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { planPinnedMove } from "@t3tools/client-runtime/state/thread-sort";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadOrderAfterMove,
  threadDropLifecycle,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
  type ThreadMoveAvailability,
} from "./threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  resolveThreadListV2Status,
  sortThreadsForListV2,
  threadListV2ListItemsAreEqual,
  threadHasUnseenCompletion,
  type ThreadListV2ListItem,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    ...input,
  });
}

const NOW = "2026-06-02T00:00:00.000Z";

describe("resolveThreadListV2Status", () => {
  it("distinguishes usage limits from ordinary failures and clears the label after recovery", () => {
    const thread = makeThread({
      id: ThreadId.make("limited"),
      title: "Limited",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("limited");
    expect(
      resolveThreadListV2Status({
        ...thread,
        runtime: { ...thread.runtime!, lastErrorClass: null },
      }),
    ).toBe("failed");
    expect(
      resolveThreadListV2Status({
        ...thread,
        runtime: { ...thread.runtime!, status: "completed" },
      }),
    ).toBe("ready");
  });

  it("prioritizes approval over a running runtime", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      runtime: {
        status: "running",
        activeRunId: RunId.make("run-t"),
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("reports waiting when presentation parks runtime idle for background tasks", () => {
    expect(
      resolveThreadListV2Status(
        makeThread({
          id: ThreadId.make("t"),
          title: "t",
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
          runtime: {
            status: "idle",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBe("waiting");
  });

  it.each([
    { kind: "command", status: "ready" },
    { kind: "monitor", status: "waiting" },
  ] as const)(
    "presents an unseen completion with a $kind roster as $status",
    ({ kind, status }) => {
      const thread = presentThreadShell(
        environmentId,
        makeRawThreadShell({
          latestRunId: RunId.make("run-background-completion"),
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lastVisitedAt: DateTime.makeUnsafe("2026-06-01T23:59:00.000Z"),
          pendingBackgroundTasks: [{ taskId: "background-work", kind }],
        }),
      );

      expect(resolveThreadListV2Status(thread)).toBe(status);
      expect(threadHasUnseenCompletion(thread)).toBe(true);
    },
  );

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("sortThreadsForListV2", () => {
  it("honors a saved active order and leaves new threads above it", () => {
    const sorted = sortThreadsForListV2([
      { id: "newer-arranged", createdAt: "2026-06-01T12:00:00.000Z", activeOrderKey: "t" },
      { id: "older-arranged", createdAt: "2026-06-01T08:00:00.000Z", activeOrderKey: "f" },
      { id: "new", createdAt: "2026-06-01T13:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["new", "older-arranged", "newer-arranged"]);
  });

  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("getThreadListV2OrderedSection", () => {
  it("uses each saved order and excludes archived rows", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active-later"), title: "Later", activeOrderKey: "t" }),
      makeThread({ id: ThreadId.make("active-first"), title: "First", activeOrderKey: "f" }),
      makeThread({ id: ThreadId.make("active-new"), title: "New" }),
      makeThread({
        id: ThreadId.make("pinned-later"),
        title: "Pinned later",
        pinnedAt: NOW,
        pinOrderKey: "t",
        activeOrderKey: "f",
      }),
      makeThread({
        id: ThreadId.make("pinned-first"),
        title: "Pinned first",
        pinnedAt: NOW,
        pinOrderKey: "f",
        activeOrderKey: "t",
      }),
      makeThread({ id: ThreadId.make("archived"), title: "Archived", archivedAt: NOW }),
    ];
    expect(
      getThreadListV2OrderedSection({ threads, section: "active" }).map((thread) => thread.id),
    ).toEqual(["active-new", "active-first", "active-later"]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "pinned" }).map((thread) => thread.id),
    ).toEqual(["pinned-first", "pinned-later"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      environmentId: null,
      searchQuery: "",
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      pinned: true,
    });
  });

  it("keeps cards in creation order", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["newer-created", "older-created"]);
    expect(items.map((item) => item.isLast)).toEqual([false, true]);
  });

  it("filters by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
      ],
      environmentId: null,
      searchQuery: "login",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["match"]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("scopes the flat list to one project", () => {
    const projectId = ProjectId.make("project-1");
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), projectId, title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId }],
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const projectId = ProjectId.make("project-1");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), projectId, title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          projectId,
          title: "Remote",
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId },
        { environmentId: remoteEnvironmentId, projectId },
      ],
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

function makePendingTask(id: string): PendingNewTask {
  const creation = {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: id,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

describe("buildThreadListV2ListItems", () => {
  const layout = buildThreadListV2Items({
    threads: [makeThread({ id: ThreadId.make("active"), title: "active" })],
    environmentId: null,
    searchQuery: "",
  });

  it("ends the list with queued tasks after the active block", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
    });

    expect(
      items.map((item) =>
        item.type === "v2-pending"
          ? item.pendingTask.title
          : item.type === "v2-thread"
            ? item.item.thread.id
            : item.type,
      ),
    ).toEqual(["active", "queued-1", "queued-2"]);
    expect(
      items.filter((item) => item.type === "v2-pending" && item.showPendingDivider),
    ).toHaveLength(1);
  });

  it("skips queued tasks when resolving thread jump targets", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-thread", "v2-pending"]);
    expect(threadJumpTarget(items, "thread.jump.1")?.id).toBe("active");
    expect(threadJumpTarget(items, "thread.jump.2")).toBeNull();
  });
});

describe("pending mobile thread moves", () => {
  function fixture(section: "active" | "pinned" = "active") {
    const rows = ["a", "b", "c"].map((id, index) =>
      makeThread({
        id: ThreadId.make(id),
        title: id === "a" ? "hidden" : "match",
        createdAt: `2026-06-01T0${3 - index}:00:00.000Z`,
        pinnedAt: section === "pinned" ? `2026-06-01T0${3 - index}:00:00.000Z` : null,
      }),
    );
    const ordered = getThreadListV2OrderedSection({ threads: rows, section });
    const orderedIds = ordered.map((row) => `${row.environmentId}:${row.id}`);
    const movedId = orderedIds[2]!;
    const assignments = planPinnedMove({
      orderedIds,
      keysById: new Map(orderedIds.map((id) => [id, null])),
      movedId,
      direction: "up",
    })!;
    const pending = createPendingThreadOrder({
      section,
      ordered,
      movedId,
      direction: "up",
      assignments,
    });
    const update = (current: EnvironmentThreadShell[], assignment: (typeof assignments)[number]) =>
      current.map((row) =>
        `${row.environmentId}:${row.id}` === assignment.id
          ? {
              ...row,
              [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignment.orderKey,
            }
          : row,
      );
    return { rows, assignments, pending, update };
  }

  function layout(
    rows: EnvironmentThreadShell[],
    pendingOrder: PendingThreadOrder | null,
    searchQuery = "",
  ) {
    return buildThreadListV2Items({
      threads: rows,
      pendingOrder,
      environmentId: null,
      searchQuery,
    }).items.map((item) => item.thread.id);
  }

  it.each(["active", "pinned"] as const)(
    "holds %s order through every intermediate key upsert",
    (section) => {
      const { rows, assignments, pending, update } = fixture(section);
      let current = rows;
      let hold: PendingThreadOrder | null = pending;
      const desired = pending.orderedIds.map((id) => id.split(":")[1]);
      expect(layout(current, hold)).toEqual(desired);
      for (const assignment of assignments) {
        current = update(current, assignment);
        hold = reconcilePendingThreadOrder(
          hold!,
          getThreadListV2OrderedSection({ threads: current, section }),
        );
        expect(hold).not.toBeNull();
        expect(layout(current, hold)).toEqual(desired);
      }
      expect(reconcilePendingThreadOrder({ ...hold!, commandsComplete: true }, current)).toBeNull();
      expect(layout(current, null)).toEqual(desired);
    },
  );

  it("keeps the action guard pending when receipts precede canonical shells", () => {
    const { rows, assignments, pending, update } = fixture();
    let hold: PendingThreadOrder | null = { ...pending, commandsComplete: true };
    let current = rows;
    expect(reconcilePendingThreadOrder(hold, current)).toBe(hold);
    for (const [index, assignment] of assignments.entries()) {
      current = update(current, assignment);
      hold = reconcilePendingThreadOrder(hold!, current);
      expect(hold === null).toBe(index === assignments.length - 1);
      expect(layout(current, hold)).toEqual(["a", "c", "b"]);
    }
  });

  it("keeps search results in the full pending section order", () => {
    const { rows, assignments, pending, update } = fixture();
    const current = update(update(rows, assignments[0]!), assignments[1]!);
    expect(layout(current, pending, "match")).toEqual(["c", "b"]);
  });

  it("releases for real section membership and foreign key changes", () => {
    const { rows, pending } = fixture();
    expect(reconcilePendingThreadOrder(pending, rows.slice(1))).toBeNull();
    const newRow = makeThread({ id: ThreadId.make("new"), title: "new" });
    expect(reconcilePendingThreadOrder(pending, [...rows, newRow])).toBeNull();
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row, index) => (index === 0 ? { ...row, activeOrderKey: "zz" } : row)),
      ),
    ).toBeNull();
    const archived = rows.map((row, index) => (index === 0 ? { ...row, archivedAt: NOW } : row));
    expect(layout(archived, pending)).toEqual(layout(archived, null));
  });

  it("does not hide a concurrent return to a previously confirmed key", () => {
    const { rows, assignments, pending, update } = fixture();
    const confirmed = reconcilePendingThreadOrder(pending, update(rows, assignments[0]!))!;
    expect(reconcilePendingThreadOrder(confirmed, rows)).toBeNull();
  });

  it("preserves the hold for activity but releases for a re-pinned sort anchor", () => {
    const { rows, pending } = fixture("pinned");
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row) => ({ ...row, updatedAt: NOW })),
      ),
    ).toBe(pending);
    expect(
      reconcilePendingThreadOrder(
        pending,
        rows.map((row, index) => (index === 0 ? { ...row, pinnedAt: NOW } : row)),
      ),
    ).toBeNull();
  });
});

describe("mobile move availability", () => {
  const oldEnvironment = EnvironmentId.make("older-server");
  function rows(section: "active" | "pinned", keys: readonly (string | null)[]) {
    return keys.map((key, index) =>
      makeThread({
        id: ThreadId.make(`move-${index}`),
        title: `Move ${index}`,
        environmentId: index === 1 ? oldEnvironment : environmentId,
        activeOrderKey: section === "active" ? key : null,
        pinOrderKey: section === "pinned" ? key : null,
        pinnedAt: section === "pinned" ? NOW : null,
      }),
    );
  }

  it.each(["active", "pinned"] as const)(
    "keeps unsupported keyed %s neighbors as usable anchors",
    (section) => {
      const ordered = rows(section, ["bb", "dd", "ff"]);
      const plan = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      });
      const assignments = plan(`${environmentId}:move-0`, "down");
      expect(assignments).toHaveLength(1);
      expect(assignments![0]!.id).toBe(`${environmentId}:move-0`);
      expect(assignments![0]!.orderKey > "dd").toBe(true);
      expect(assignments![0]!.orderKey < "ff").toBe(true);
      expect(plan(`${oldEnvironment}:move-1`, "up")).toBeNull();
      expect(plan(`${environmentId}:move-0`, "up")).toBeNull();
    },
  );

  it.each(["active", "pinned"] as const)(
    "disables %s moves requiring unsupported keyless materialization",
    (section) => {
      const ordered = rows(section, [null, null, null]);
      const plan = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      });
      expect(plan(`${environmentId}:move-0`, "down")).toBeNull();
      expect(plan(`${environmentId}:move-2`, "up")).toBeNull();
      const supported = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId, oldEnvironment]),
      });
      expect(supported(`${environmentId}:move-0`, "down")).toHaveLength(3);
    },
  );

  it.each(["active", "pinned"] as const)(
    "reserves hidden %s keys when moving visible rows",
    (section) => {
      const ordered = rows(section, ["bb", "dd", "ff"]);
      const input = { ordered, section, reorderableEnvironmentIds: new Set([environmentId]) };
      const collision = createThreadMovePlanner(input)(`${environmentId}:move-0`, "down")![0]!
        .orderKey;
      const hidden = {
        ...ordered[0]!,
        id: ThreadId.make("archived"),
        archivedAt: NOW,
        pinOrderKey: section === "pinned" ? collision : null,
        activeOrderKey: section === "active" ? collision : null,
      };
      const assignments = createThreadMovePlanner({ ...input, allThreads: [...ordered, hidden] })(
        `${environmentId}:move-0`,
        "down",
      );
      expect(assignments).toHaveLength(1);
      expect(assignments![0]!.orderKey).not.toBe(collision);
      expect(assignments![0]!.orderKey > "dd" && assignments![0]!.orderKey < "ff").toBe(true);
    },
  );

  it("allows an independent keyed move despite an unsupported keyless row elsewhere", () => {
    const ordered = rows("active", [null, null, "bb", "dd", "ff"]);
    const plan = createThreadMovePlanner({
      ordered,
      section: "active",
      reorderableEnvironmentIds: new Set([environmentId]),
    });
    const assignments = plan(`${environmentId}:move-4`, "up");
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe(`${environmentId}:move-4`);
    expect(assignments![0]!.orderKey > "bb").toBe(true);
    expect(assignments![0]!.orderKey < "dd").toBe(true);
  });
});

describe("thread drag destinations", () => {
  it("moves across multiple rows while keeping hidden anchors in place", () => {
    expect(
      threadOrderAfterMove(["a", "hidden", "b", "c"], "c", {
        targetId: "a",
        placement: "before",
      }),
    ).toEqual(["c", "a", "hidden", "b"]);
    expect(
      threadOrderAfterMove(["a", "hidden", "b", "c"], "a", {
        targetId: "b",
        placement: "after",
      }),
    ).toEqual(["hidden", "b", "a", "c"]);
  });

  it("rejects missing, self, and unchanged destinations", () => {
    for (const targetId of ["missing", "a", "b"]) {
      expect(
        threadOrderAfterMove(["a", "b", "c"], "a", {
          targetId,
          placement: "before",
        }),
      ).toBeNull();
    }
    expect(threadOrderAfterMove(["a", "b"], "missing", "down")).toBeNull();
  });

  it.each(["active", "pinned"] as const)(
    "persists a dropped %s row and holds its order until confirmed",
    (section) => {
      const ordered = ["a", "b", "c", "d"].map((id) =>
        makeThread({
          id: ThreadId.make(id),
          title: id,
          pinnedAt: section === "pinned" ? NOW : null,
        }),
      );
      const ids = ordered.map((row) => `${row.environmentId}:${row.id}`);
      const direction = { targetId: ids[0]!, placement: "before" as const };
      const assignments = createThreadMovePlanner({
        ordered,
        section,
        reorderableEnvironmentIds: new Set([environmentId]),
      })(ids[3]!, direction)!;
      const pending = createPendingThreadOrder({
        section,
        ordered,
        movedId: ids[3]!,
        direction,
        assignments,
      });
      expect(pending.orderedIds).toEqual([ids[3], ids[0], ids[1], ids[2]]);
      const confirmed = ordered.map((row) => ({
        ...row,
        [section === "pinned" ? "pinOrderKey" : "activeOrderKey"]: assignments.find(
          (a) => a.id === `${row.environmentId}:${row.id}`,
        )!.orderKey,
      }));
      expect(
        getThreadListV2OrderedSection({ threads: confirmed, section }).map(
          (row) => `${row.environmentId}:${row.id}`,
        ),
      ).toEqual(pending.orderedIds);
      expect(
        reconcilePendingThreadOrder({ ...pending, commandsComplete: true }, confirmed),
      ).toBeNull();
    },
  );

  it("refuses a drop that would need to rewrite an old server's keyless row", () => {
    const old = EnvironmentId.make("old-server");
    const ordered = [environmentId, old, environmentId].map((env, index) =>
      makeThread({
        id: ThreadId.make(String(index)),
        title: String(index),
        environmentId: env,
      }),
    );
    expect(
      createThreadMovePlanner({
        ordered,
        section: "active",
        reorderableEnvironmentIds: new Set([environmentId]),
      })(`${environmentId}:2`, { targetId: `${environmentId}:0`, placement: "before" }),
    ).toBeNull();
  });
});

it("allows a long drop past an old server even when both adjacent moves fail", () => {
  const old = EnvironmentId.make("old-server");
  const ordered = [
    makeThread({ id: ThreadId.make("a"), title: "a" }),
    makeThread({ id: ThreadId.make("b"), title: "b", environmentId: old }),
    makeThread({ id: ThreadId.make("c"), title: "c", activeOrderKey: "h" }),
    makeThread({ id: ThreadId.make("d"), title: "d", activeOrderKey: "p" }),
  ];
  const planner = createThreadMovePlanner({
    ordered,
    section: "active",
    reorderableEnvironmentIds: new Set([environmentId]),
  });
  const movedId = `${environmentId}:a`;
  expect(planner(movedId, "up")).toBeNull();
  expect(planner(movedId, "down")).toBeNull();
  const assignments = planner(movedId, { targetId: `${environmentId}:d`, placement: "after" });
  expect(assignments).toHaveLength(1);
  expect(assignments![0]!.id).toBe(movedId);
  expect(assignments![0]!.orderKey > "p").toBe(true);
});

describe("cross-section thread drops", () => {
  it.each(["pinned", "active"] as const)("inserts into an empty %s section", (section) => {
    const thread = makeThread({ id: ThreadId.make("source"), title: "source" });
    const id = `${thread.environmentId}:${thread.id}`;
    const destination = { section, targetId: null, placement: "before" as const };
    expect(threadOrderAfterMove([], id, destination)).toEqual([id]);
    const plan = createThreadMovePlanner({
      ordered: [],
      allThreads: [thread],
      section,
      reorderableEnvironmentIds: new Set([environmentId]),
    })(id, destination);
    expect(plan).toHaveLength(1);
    expect(plan![0]!.id).toBe(id);
  });
  it("places an incoming row between existing anchors without rewriting them", () => {
    const a = makeThread({ id: ThreadId.make("a"), title: "a", pinOrderKey: "h" });
    const b = makeThread({ id: ThreadId.make("b"), title: "b", pinOrderKey: "z" });
    const source = makeThread({ id: ThreadId.make("source"), title: "source" });
    const id = `${environmentId}:source`;
    const destination = {
      section: "pinned" as const,
      targetId: `${environmentId}:b`,
      placement: "before" as const,
    };
    const plan = createThreadMovePlanner({
      ordered: [a, b],
      allThreads: [a, b, source],
      section: "pinned",
      reorderableEnvironmentIds: new Set([environmentId]),
    })(id, destination);
    expect(plan).toHaveLength(1);
    expect(plan![0]!.orderKey > "h" && plan![0]!.orderKey < "z").toBe(true);
    expect(
      threadOrderAfterMove([`${environmentId}:a`, `${environmentId}:b`], id, destination),
    ).toEqual([`${environmentId}:a`, id, `${environmentId}:b`]);
  });
  it("rejects removed targets and unsupported incoming sources", () => {
    expect(
      threadOrderAfterMove(["a"], "source", {
        section: "active",
        targetId: "gone",
        placement: "before",
      }),
    ).toBeNull();
    const source = makeThread({ id: ThreadId.make("source"), title: "source" });
    expect(
      createThreadMovePlanner({
        ordered: [],
        allThreads: [source],
        section: "active",
        reorderableEnvironmentIds: new Set(),
      })(`${environmentId}:source`, { section: "active", targetId: null, placement: "before" }),
    ).toBeNull();
  });
  it("clears pinning when returning a pinned thread to Active", () => {
    const thread = makeThread({ id: ThreadId.make("pinned"), title: "pinned", pinnedAt: NOW });
    expect(threadDropLifecycle(thread, "active")).toEqual({ pin: false, unpin: true });
    expect(threadDropLifecycle(thread, "pinned")).toEqual({ pin: true, unpin: false });
  });
  it("does not send lifecycle commands for an ordinary Active reorder", () => {
    expect(
      threadDropLifecycle(makeThread({ id: ThreadId.make("active"), title: "active" }), "active"),
    ).toEqual({ pin: false, unpin: false });
  });
});

it("excludes subagents from navigation, search and ordering while retaining user forks", () => {
  const root = makeThread({ id: ThreadId.make("root"), title: "Root" });
  const child = makeThread({
    id: ThreadId.make("child"),
    title: "Child",
    lineage: { parentThreadId: root.id, rootThreadId: root.id, relationshipToParent: "subagent" },
  });
  const fork = makeThread({
    id: ThreadId.make("fork"),
    title: "Fork",
    lineage: { parentThreadId: root.id, rootThreadId: root.id, relationshipToParent: "fork" },
  });
  const threads = [root, child, fork];
  expect(
    buildThreadListV2Items({ threads, environmentId: null, searchQuery: "" }).items.map(
      (item) => item.thread.id,
    ),
  ).toEqual([fork.id, root.id]);
  expect(
    buildThreadListV2Items({ threads, environmentId: null, searchQuery: "Child" }).items,
  ).toEqual([]);
  expect(
    getThreadListV2OrderedSection({ threads, section: "active" }).map((thread) => thread.id),
  ).toEqual([fork.id, root.id]);
});

const BASE_MS = Date.parse(NOW);
const isoAt = (ms: number) => new Date(ms).toISOString();
const MINUTE_MS = 60_000;

function runningRuntime() {
  return {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeRunId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function buildTickThreads() {
  return {
    ready: makeThread({
      id: ThreadId.make("tick-ready"),
      title: "tick ready",
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
    approval: makeThread({
      id: ThreadId.make("tick-approval"),
      title: "tick approval",
      hasPendingApprovals: true,
      latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
    }),
  };
}

function buildTickList(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  pendingTasks: ReadonlyArray<PendingNewTask>,
  options?: {
    readonly queuedThreadKeys?: ReadonlySet<string>;
    readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  },
): ThreadListV2ListItem[] {
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
  });
  return buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    ...(options?.queuedThreadKeys ? { queuedThreadKeys: options.queuedThreadKeys } : {}),
    ...(options?.moveAvailability ? { moveAvailability: options.moveAvailability } : {}),
  });
}

function itemsByThreadKey(items: ReadonlyArray<ThreadListV2ListItem>) {
  const byKey = new Map<string, ThreadListV2ListItem>();
  for (const item of items) byKey.set(item.key, item);
  return byKey;
}

describe("threadListV2ListItemsAreEqual", () => {
  const thread = makeThread({
    id: ThreadId.make("eq"),
    title: "eq",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const layout = buildThreadListV2Items({
    threads: [thread],
    environmentId: null,
    searchQuery: "",
  });
  const queued = makePendingTask("eq-queued");
  const build = () =>
    buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [queued],
    });

  it("treats rebuilt wrappers over identical rows as equal", () => {
    const first = build();
    const second = build();
    expect(first.length).toBe(second.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]).not.toBe(second[index]);
      expect(threadListV2ListItemsAreEqual(first[index]!, second[index]!)).toBe(true);
    }
  });

  it("notices a replaced thread shell", () => {
    const replacement = makeThread({ id: ThreadId.make("eq"), title: "renamed" });
    const rebuilt = buildThreadListV2Items({
      threads: [replacement],
      environmentId: null,
      searchQuery: "",
    });
    const next = buildThreadListV2ListItems({
      items: rebuilt.items,
      pendingTasks: [],
    });
    const previousThread = build().find((item) => item.type === "v2-thread")!;
    const nextThread = next.find((item) => item.type === "v2-thread")!;
    expect(threadListV2ListItemsAreEqual(previousThread, nextThread)).toBe(false);
  });

  it("notices shelf count, expansion, and loading-disabled changes", () => {
    const shelf = {
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: 2,
      expanded: true,
      disabled: false,
    } as const;
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf })).toBe(true);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, count: 3 })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, expanded: false })).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelf, { ...shelf, disabled: true })).toBe(false);
  });

  it("treats different item kinds as unequal", () => {
    const built = build();
    const threadItem = built.find((item) => item.type === "v2-thread")!;
    const pendingItem = built.find((item) => item.type === "v2-pending")!;
    expect(threadListV2ListItemsAreEqual(threadItem, pendingItem)).toBe(false);
  });

  it("notices a trailing-divider flip caused by a neighbour change", () => {
    const threadA = makeThread({ id: ThreadId.make("flip-a"), title: "flip a" });
    const threadB = makeThread({ id: ThreadId.make("flip-b"), title: "flip b" });
    const bare = buildThreadListV2ListItems({
      items: buildThreadListV2Items({
        threads: [threadA, threadB],
        environmentId: null,
        searchQuery: "",
      }).items,
      pendingTasks: [],
    });
    const workingB = makeThread({
      id: ThreadId.make("flip-b"),
      title: "flip b",
      runtime: runningRuntime(),
    });
    const workingLayout = buildThreadListV2Items({
      threads: [threadA, workingB],
      environmentId: null,
      searchQuery: "",
      workingShelfEnabled: true,
    });
    const withWorking = buildThreadListV2ListItems({
      items: workingLayout.items,
      pendingTasks: [],
      workingCount: workingLayout.workingCount,
      workingShelfHeaderIndex: workingLayout.workingShelfHeaderIndex,
    });
    const firstA = bare[0]!;
    const secondA = withWorking[0]!;
    expect(firstA.type === "v2-thread" && firstA.showTrailingDivider).toBe(true);
    expect(secondA.type === "v2-thread" && secondA.showTrailingDivider).toBe(false);
    expect(threadListV2ListItemsAreEqual(firstA, secondA)).toBe(false);
  });
});

describe("buildThreadListV2ListItems time labels", () => {
  const tickQueued = () => [makePendingTask("tick-queued")];

  it("blanks the precomputed time for rows that render a label instead", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const working = makeThread({
        id: ThreadId.make("tick-working"),
        title: "tick working",
        latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        runtime: runningRuntime(),
      });
      const threads = buildTickThreads();
      const items = buildTickList([threads.ready, working], tickQueued());
      const byKey = itemsByThreadKey(items);
      const label = (key: string) => {
        const item = byKey.get(key)!;
        return item.type === "v2-thread" ? item.timeLabel : "<shelf>";
      };
      expect(label(`v2-thread:${environmentId}:tick-ready`)).toBe("5m");
      expect(label(`v2-thread:${environmentId}:tick-working`)).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("thread list v2 minute tick invalidation", () => {
  it("only invalidates rows whose clock-driven content moved", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const threads = buildTickThreads();
      const shellOrder = [threads.ready, threads.approval];
      const pendingTasks = [makePendingTask("tick-queued")];
      const atStart = buildTickList(shellOrder, pendingTasks);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList(shellOrder, pendingTasks);

      expect(atStart.length).toBe(atNextMinute.length);
      const invalidated: string[] = [];
      for (let index = 0; index < atStart.length; index += 1) {
        if (!threadListV2ListItemsAreEqual(atStart[index]!, atNextMinute[index]!)) {
          invalidated.push(atStart[index]!.key);
        }
      }
      expect(invalidated).toEqual([`v2-thread:${environmentId}:tick-ready`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unread completion labels stable across a minute tick", () => {
    const unread = makeThread({
      id: ThreadId.make("tick-unread"),
      title: "Unread completion",
      lastVisitedAt: isoAt(BASE_MS - 10 * MINUTE_MS),
      latestRun: {
        runId: RunId.make("tick-unread-run"),
        status: "completed",
        requestedAt: isoAt(BASE_MS - 6 * MINUTE_MS),
        startedAt: isoAt(BASE_MS - 6 * MINUTE_MS),
        completedAt: isoAt(BASE_MS - 5 * MINUTE_MS),
        assistantMessageId: null,
      },
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const first = buildTickList([unread], [])[0]!;
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const next = buildTickList([unread], [])[0]!;
      expect(first.type === "v2-thread" && first.timeLabel).toBe("");
      expect(threadListV2ListItemsAreEqual(first, next)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps hour-granularity rows stable across a minute tick", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_MS);
      const staleReady = makeThread({
        id: ThreadId.make("tick-stale"),
        title: "tick stale",
        latestUserMessageAt: isoAt(BASE_MS - 3 * 60 * MINUTE_MS),
      });
      const atStart = buildTickList([staleReady], []);
      vi.setSystemTime(BASE_MS + MINUTE_MS);
      const atNextMinute = buildTickList([staleReady], []);
      expect(threadListV2ListItemsAreEqual(atStart[0]!, atNextMinute[0]!)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildThreadListV2ListItems trailing dividers", () => {
  it("follows the final neighbour order, not the pre-splice blocks", () => {
    const activeA = makeThread({ id: ThreadId.make("div-a"), title: "a" });
    const activeB = makeThread({ id: ThreadId.make("div-b"), title: "b" });
    const layout = buildThreadListV2Items({
      threads: [activeA, activeB],
      environmentId: null,
      searchQuery: "",
    });
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("div-q1"), makePendingTask("div-q2")],
    });
    const dividers = items.map((item) =>
      item.type === "v2-thread" || item.type === "v2-pending" ? item.showTrailingDivider : "n/a",
    );
    expect(dividers).toEqual([true, false, true, false]);
  });
});

describe("buildThreadListV2ListItems row-state stamps", () => {
  const readyThread = makeThread({
    id: ThreadId.make("stamp-ready"),
    title: "stamp ready",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });
  const otherThread = makeThread({
    id: ThreadId.make("stamp-other"),
    title: "stamp other",
    latestUserMessageAt: isoAt(BASE_MS - 5 * MINUTE_MS),
  });

  it("stamps queued outbox messages onto the matching row and notices removal", () => {
    const queued = buildTickList([readyThread, otherThread], [], {
      queuedThreadKeys: new Set([`${environmentId}:stamp-ready`]),
    });
    const plain = buildTickList([readyThread, otherThread], [], {
      queuedThreadKeys: new Set<string>(),
    });
    const byKey = (items: ThreadListV2ListItem[]) => itemsByThreadKey(items);
    const readyQueued = byKey(queued).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const readyPlain = byKey(plain).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const otherQueued = byKey(queued).get(`v2-thread:${environmentId}:stamp-other`)!;
    const otherPlain = byKey(plain).get(`v2-thread:${environmentId}:stamp-other`)!;
    expect(readyQueued.type === "v2-thread" && readyQueued.hasQueuedMessages).toBe(true);
    expect(readyPlain.type === "v2-thread" && readyPlain.hasQueuedMessages).toBe(false);
    expect(threadListV2ListItemsAreEqual(readyQueued, readyPlain)).toBe(false);
    expect(threadListV2ListItemsAreEqual(otherQueued, otherPlain)).toBe(true);
  });

  it("notices move-availability changes on card rows without a shell update", () => {
    const permissive = new Map([
      [`${environmentId}:stamp-ready`, { canMoveUp: true, canMoveDown: true }],
    ]);
    const open = buildTickList([readyThread], [], { moveAvailability: permissive });
    const closed = buildTickList([readyThread], [], { moveAvailability: new Map() });
    const readyOpen = itemsByThreadKey(open).get(`v2-thread:${environmentId}:stamp-ready`)!;
    const readyClosed = itemsByThreadKey(closed).get(`v2-thread:${environmentId}:stamp-ready`)!;
    expect(readyOpen.type === "v2-thread" && readyOpen.canMoveUp).toBe(true);
    expect(readyClosed.type === "v2-thread" && readyClosed.canMoveUp).toBe(false);
    expect(threadListV2ListItemsAreEqual(readyOpen, readyClosed)).toBe(false);
  });

  it("stamps the shelf loading-disabled state so recycled headers refresh", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("stamp-working"),
          title: "stamp working",
          runtime: runningRuntime(),
        }),
      ],
      environmentId: null,
      searchQuery: "",
      workingShelfEnabled: true,
    });
    const shelf = (shelfPreferencesLoading: boolean) =>
      buildThreadListV2ListItems({
        items: layout.items,
        pendingTasks: [],
        workingCount: layout.workingCount,
        workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
        shelfPreferencesLoading,
      }).find((item) => item.type === "v2-working-shelf")!;
    const shelfLoading = shelf(true);
    const shelfLoaded = shelf(false);
    expect(shelfLoading.type === "v2-working-shelf" && shelfLoading.disabled).toBe(true);
    expect(shelfLoaded.type === "v2-working-shelf" && shelfLoaded.disabled).toBe(false);
    expect(threadListV2ListItemsAreEqual(shelfLoading, shelfLoaded)).toBe(false);
  });
});

describe("Working section beta", () => {
  const running = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: NOW,
  };
  const finishedAt = (id: string, completedAt: string) =>
    makeThread({
      id: ThreadId.make(id),
      title: id,
      createdAt: "2026-06-01T00:00:00.000Z",
      latestRun: {
        runId: RunId.make(`run-${id}`),
        status: "completed",
        requestedAt: "2026-06-01T00:00:00.000Z",
        startedAt: "2026-06-01T00:00:00.000Z",
        completedAt,
        assistantMessageId: null,
      },
    });
  const threads = [
    finishedAt("finished-early", "2026-06-01T01:00:00.000Z"),
    finishedAt("finished-late", "2026-06-01T03:00:00.000Z"),
    makeThread({ id: ThreadId.make("working"), title: "working", runtime: running }),
    makeThread({
      id: ThreadId.make("asks-approval"),
      title: "asks-approval",
      createdAt: "2026-06-01T02:00:00.000Z",
      runtime: running,
      hasPendingApprovals: true,
    }),
    makeThread({
      id: ThreadId.make("pinned-working"),
      title: "pinned-working",
      runtime: running,
      pinnedAt: "2026-06-01T00:00:00.000Z",
    }),
  ];
  const build = (input: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {}) =>
    buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      workingShelfEnabled: true,
      ...input,
    });
  const ids = (layout: ReturnType<typeof buildThreadListV2Items>) =>
    layout.items.map((item) => item.thread.id);

  it("folds unpinned working threads into a collapsed shelf", () => {
    const layout = build();
    expect(ids(layout)).toEqual([
      "pinned-working",
      "finished-late",
      "asks-approval",
      "finished-early",
    ]);
    expect(layout.workingCount).toBe(1);
    expect(layout.workingShelfHeaderIndex).toBe(4);

    const off = build({ workingShelfEnabled: false });
    expect(ids(off)).toContain("working");
    expect(off.workingCount).toBe(0);
  });

  it("shows working rows as cards when expanded, or only the selected one when collapsed", () => {
    expect(build({ workingShelfExpanded: true }).items.at(-1)).toMatchObject({
      thread: { id: "working" },
    });
    expect(ids(build({ selectedThreadKey: `${environmentId}:working` })).at(-1)).toBe("working");
  });

  it("orders the inbox by the latest return this device observed", () => {
    const layout = build({
      inboxReturnAt: (thread) =>
        thread.id === "finished-early" ? Date.parse("2026-06-01T04:00:00.000Z") : undefined,
    });
    expect(ids(layout).slice(1)).toEqual(["finished-early", "finished-late", "asks-approval"]);
  });

  it("places the shelf after queued tasks", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({ id: ThreadId.make("working"), title: "working", runtime: running }),
      ],
      environmentId: null,
      searchQuery: "",
      workingShelfEnabled: true,
      workingShelfExpanded: true,
    });
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued")],
      workingCount: layout.workingCount,
      workingShelfExpanded: true,
      workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
    });
    expect(
      items.map((item) =>
        item.type === "v2-thread"
          ? item.item.thread.id
          : item.type === "v2-pending"
            ? item.pendingTask.title
            : item.type,
      ),
    ).toEqual(["active", "queued", "v2-working-shelf", "working"]);
  });
});
