import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  denialReason,
  PERMISSION_BLOCKER_OPTIONS,
  permissionBlockerCard,
  unresolvedPermissionDenial,
} from "./permissionBlocker.ts";

const BLOCKED =
  "Error: Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Deploy]. If you have other tasks…";

function item(
  ordinal: number,
  fields: Record<string, unknown> & { readonly type: OrchestrationV2TurnItem["type"] },
): OrchestrationV2TurnItem {
  return {
    id: `item-${ordinal}`,
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-11-10T00:00:00.000Z",
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
}

const denied = (ordinal: number, command = "gh workflow run release.yml --ref main") =>
  item(ordinal, {
    type: "command_execution",
    status: "failed",
    input: command,
    output: BLOCKED,
    toolNonExecutionKind: "automode-blocked",
  });
const ran = (ordinal: number, command = "git status") =>
  item(ordinal, { type: "command_execution", input: command, output: "ok" });
const message = (ordinal: number) =>
  item(ordinal, { type: "assistant_message", text: "Blocked.", messageId: "m", streaming: false });
const t3Tool = (ordinal: number, name = "team_status") =>
  item(ordinal, { type: "dynamic_tool", toolName: `mcp__t3-code__${name}`, input: {} });

describe("unresolvedPermissionDenial", () => {
  it("finds a denial the turn ended on", () => {
    const denial = unresolvedPermissionDenial([ran(1), denied(2), message(3)]);
    assert.deepStrictEqual(denial, {
      kind: "automode-blocked",
      action: "gh workflow run release.yml --ref main",
      reason: "Production Deploy",
    });
  });

  it("ignores a denial the turn moved past with real work", () => {
    assert.strictEqual(unresolvedPermissionDenial([denied(1), ran(2, "git commit -m x")]), null);
  });

  it("does not count reading status or memory as moving on", () => {
    const denial = unresolvedPermissionDenial([denied(1), t3Tool(2), t3Tool(3, "memory_write")]);
    assert.strictEqual(denial?.reason, "Production Deploy");
  });

  it("counts BusyBoy tools that do work as moving on", () => {
    for (const name of ["task_create", "task_delegate", "t3_thread_send", "task_ready"]) {
      assert.strictEqual(unresolvedPermissionDenial([denied(1), t3Tool(2, name)]), null);
    }
  });

  it("reads items in ordinal order and reports the last denial", () => {
    const denial = unresolvedPermissionDenial([denied(3, "second"), ran(2), denied(1, "first")]);
    assert.strictEqual(denial?.action, "second");
  });

  it("covers safety-rule denials and skips user rejections and missing verdicts", () => {
    const rule = item(1, {
      type: "command_execution",
      status: "failed",
      input: "rm -rf build",
      output:
        "Error: Permission for this command was denied by a built-in Claude Code safety check",
      toolNonExecutionKind: "permission-rule",
    });
    assert.deepStrictEqual(unresolvedPermissionDenial([rule]), {
      kind: "permission-rule",
      action: "rm -rf build",
      reason: null,
    });
    for (const kind of ["user-rejected", "automode-unavailable", "interrupted"]) {
      const other = item(1, {
        type: "command_execution",
        status: "failed",
        input: "x",
        toolNonExecutionKind: kind,
      });
      assert.strictEqual(unresolvedPermissionDenial([other]), null);
    }
  });

  it("is null without any denial", () => {
    assert.strictEqual(unresolvedPermissionDenial([ran(1), message(2)]), null);
  });
});

describe("permissionBlockerCard", () => {
  it("names who is blocked, the action, the reason and the impact", () => {
    const card = permissionBlockerCard({
      who: "Jota",
      denial: {
        kind: "automode-blocked",
        action: "gh workflow run release.yml",
        reason: "Production Deploy",
      },
    });
    assert.isTrue(card.question.startsWith("Jota 막힘: 자동 권한 검사가 작업을 거부했어요"));
    assert.include(card.question, "gh workflow run release.yml");
    assert.include(card.question, "Production Deploy");
    assert.deepStrictEqual(card.options, PERMISSION_BLOCKER_OPTIONS);
    assert.deepStrictEqual(card.context.impacts, ["deploy"]);
    assert.strictEqual(card.context.reversibility, "unknown");
  });

  it("maps merge and publish reasons and leaves others without an impact", () => {
    const impacts = (reason: string | null) =>
      permissionBlockerCard({
        who: "#1 A",
        denial: { kind: "automode-blocked", action: "x", reason },
      }).context.impacts;
    assert.deepStrictEqual(impacts("Merge Without Review"), ["merge"]);
    assert.deepStrictEqual(impacts("Create Public Surface"), ["publish"]);
    assert.deepStrictEqual(impacts("Git Destructive"), []);
    assert.deepStrictEqual(impacts(null), []);
  });
});

describe("denialReason", () => {
  it("reads the bracketed reason", () => {
    assert.strictEqual(denialReason(BLOCKED), "Production Deploy");
    assert.strictEqual(denialReason("no reason here"), null);
  });
});
