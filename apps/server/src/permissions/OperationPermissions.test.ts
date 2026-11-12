import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { withOperationPermission } from "../mcp/OperationPermissionCards.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { layer, OperationPermissions } from "./OperationPermissions.ts";

const threadId = ThreadId.make("caller");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "permission-test",
  thread: { threadId, providerInstanceId, providerSessionId: "session-private" },
  client: undefined,
};
const request = {
  operation: "t3_thread_send",
  summary: "메시지를 보냅니다.",
  reason: "대상이 더 넓은 권한으로 실행합니다.",
  targetDescription: "target (full-access)",
  fingerprint: "sensitive-argument-digest",
};

function permissionHarness() {
  const cards = new Map<string, Record<string, unknown>>();
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  let status = "running";
  let session = "session-private";
  let executions = 0;
  const management = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.sync(
        () =>
          ({
            thread: { id: threadId, archivedAt: null },
            runs: [
              {
                id: "run",
                ordinal: 1,
                status,
                providerInstanceId,
                rootNodeId: "node",
                providerThreadId: "provider-thread",
              },
            ],
            providerThreads: [{ id: "provider-thread", providerSessionId: session }],
            turnItems: [...cards.values()],
          }) as never,
      ),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "operation_permission.record") {
          cards.set(command.turnItemId, {
            ...command,
            id: command.turnItemId,
            type: "operation_permission",
          });
        }
        return {} as never;
      }),
  });

  return {
    management,
    layer: layer.pipe(Layer.provide(management)),
    cards,
    dispatched,
    effect: Effect.sync(() => {
      executions += 1;
      return "executed";
    }),
    executions: () => executions,
    stop: () => {
      status = "completed";
    },
    replaceSession: () => {
      session = "another-session";
    },
  };
}

const pendingPermission = (h: ReturnType<typeof permissionHarness>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i += 1) {
      const card = [...h.cards.values()].find((item) => item.permissionStatus === "pending");
      if (card !== undefined) {
        return card.id as TurnItemId;
      }
      yield* Effect.yieldNow;
    }
    throw new Error("No pending operation permission appeared.");
  });

describe("OperationPermissions", () => {
  it.effect("executes only after the user approves and records one consumption and result", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(Effect.forkChild);
      const turnItemId = yield* pendingPermission(h);
      assert.strictEqual(h.executions(), 0);
      const wrongCaller = yield* permissions
        .answer({ threadId: ThreadId.make("other"), turnItemId, decision: "allow" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(wrongCaller));
      yield* permissions.answer({ threadId, turnItemId, decision: "allow" });
      const duplicate = yield* permissions
        .answer({ threadId, turnItemId, decision: "allow" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(duplicate));
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(fiber), "executed");
      assert.strictEqual(h.executions(), 1);
      assert.deepStrictEqual(
        h.dispatched.flatMap((command) =>
          command.type === "operation_permission.record" ? [command.permissionStatus] : [],
        ),
        ["pending", "approved", "consumed", "succeeded"],
      );
      const log = JSON.stringify(h.dispatched);
      assert.strictEqual(log.includes(request.fingerprint), false);
      assert.strictEqual(log.includes("session-private"), false);
      const replay = yield* permissions
        .answer({ threadId, turnItemId, decision: "allow" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(replay));
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a denial never runs the operation", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      const turnItemId = yield* pendingPermission(h);
      yield* permissions.answer({ threadId, turnItemId, decision: "deny" });
      yield* TestClock.adjust("1 second");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
      assert.strictEqual(h.executions(), 0);
      assert.strictEqual(h.cards.get(turnItemId)?.permissionStatus, "declined");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("expires unanswered requests without executing", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      const turnItemId = yield* pendingPermission(h);
      yield* TestClock.adjust("5 minutes");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
      assert.strictEqual(h.executions(), 0);
      assert.strictEqual(h.cards.get(turnItemId)?.permissionStatus, "expired");
    }).pipe(Effect.provide(h.layer));
  });

  for (const change of ["stop", "replaceSession"] as const) {
    it.effect(`withdraws permission when the caller changes: ${change}`, () => {
      const h = permissionHarness();
      return Effect.gen(function* () {
        const permissions = yield* OperationPermissions;
        const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(
          Effect.exit,
          Effect.forkChild,
        );
        const turnItemId = yield* pendingPermission(h);
        h[change]();
        const answer = yield* permissions
          .answer({ threadId, turnItemId, decision: "allow" })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(answer));
        yield* TestClock.adjust("1 second");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
        assert.strictEqual(h.executions(), 0);
        assert.strictEqual(h.cards.get(turnItemId)?.permissionStatus, "cancelled");
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("cancels interrupted requests and rejects approval after interruption", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(Effect.forkChild);
      const turnItemId = yield* pendingPermission(h);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(h.cards.get(turnItemId)?.permissionStatus, "cancelled");
      const late = yield* permissions
        .answer({ threadId, turnItemId, decision: "allow" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(late));
      assert.strictEqual(h.executions(), 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("retains failure after an approved operation fails", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(
        scope,
        request,
        Effect.fail("write failed"),
      ).pipe(Effect.exit, Effect.forkChild);
      const turnItemId = yield* pendingPermission(h);
      yield* permissions.answer({ threadId, turnItemId, decision: "allow" });
      yield* TestClock.adjust("1 second");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
      assert.strictEqual(h.cards.get(turnItemId)?.permissionStatus, "failed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("accepts only one of two concurrent approvals", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(Effect.forkChild);
      const turnItemId = yield* pendingPermission(h);
      const answers = yield* Effect.forEach(
        [1, 2],
        () => permissions.answer({ threadId, turnItemId, decision: "allow" }).pipe(Effect.exit),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(answers.filter(Exit.isSuccess).length, 1);
      assert.strictEqual(answers.filter(Exit.isFailure).length, 1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.strictEqual(h.executions(), 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("rechecks the calling session after approval and before consumption", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      const turnItemId = yield* pendingPermission(h);
      yield* permissions.answer({ threadId, turnItemId, decision: "allow" });
      h.replaceSession();
      yield* TestClock.adjust("1 second");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
      assert.strictEqual(h.executions(), 0);
      assert.strictEqual(h.cards.get(turnItemId)?.permissionStatus, "cancelled");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("cannot restore an old approval when the permission service restarts", () => {
    const h = permissionHarness();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions;
      const fiber = yield* withOperationPermission(scope, request, h.effect).pipe(Effect.forkChild);
      const turnItemId = yield* pendingPermission(h);
      yield* permissions.answer({ threadId, turnItemId, decision: "allow" });
      const afterRestart = yield* OperationPermissions.pipe(
        Effect.flatMap((restarted) =>
          restarted.answer({ threadId, turnItemId, decision: "allow" }),
        ),
        Effect.provide(layer.pipe(Layer.provide(h.management))),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(afterRestart));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.strictEqual(h.executions(), 1);
    }).pipe(Effect.provide(h.layer));
  });
});
