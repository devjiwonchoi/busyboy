import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type RuntimeMode,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  DispatchModeLimit,
  type DispatchModeLimitValue,
} from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as Permissions from "../../../permissions/OperationPermissions.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const harness = Effect.fn("test.scheduledExecutionHarness")(function* () {
  const callerId = ThreadId.make("caller");
  const targetId = ThreadId.make("target");
  let callerMode: RuntimeMode = "auto";
  let targetMode: RuntimeMode = "full-access";
  const requested = yield* Deferred.make<Permissions.OperationPermissionRequest>();
  const approved = yield* Deferred.make<void>();
  const runs: Array<Parameters<ScheduledTasks.ScheduledTaskService["Service"]["runNow"]>[0]> = [];
  let limit: DispatchModeLimitValue | undefined;
  const saved: ScheduledTask = {
    id: ScheduledTaskId.make("daily-check"),
    title: "Daily check",
    prompt: "Inspect the release; TOKEN=private-value",
    enabled: false,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project"),
    threadId: targetId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chosen-model" },
    runtimeMode: "auto",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "scheduled-execution",
      thread: {
        threadId: callerId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.sync(() =>
          liveThreadShell(id, { runtimeMode: id === callerId ? callerMode : targetMode }),
        ),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [saved] }),
      runNow: (input) =>
        Effect.gen(function* () {
          limit = yield* DispatchModeLimit;
          runs.push(input);
          return { task: saved };
        }),
    }),
    Layer.mock(Permissions.OperationPermissions)({
      withPermission: (_scope, request, effect) =>
        Deferred.succeed(requested, request).pipe(
          Effect.andThen(Deferred.await(approved)),
          Effect.andThen(effect),
        ),
    }),
  );
  const toolkit = yield* ThreadToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  return {
    saved,
    requested,
    approved,
    runs,
    limit: () => limit,
    setCallerMode: (mode: RuntimeMode) => {
      callerMode = mode;
    },
    setTargetMode: (mode: RuntimeMode) => {
      targetMode = mode;
    },
    call: toolkit.handle("run_scheduled_task_now", { taskId: saved.id }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((items) => items.at(-1)?.result),
      Effect.provide(dependencies),
    ),
  };
});

it.effect("shows the saved scheduled execution before approval and passes its exact snapshot", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const fiber = yield* h.call.pipe(Effect.forkChild);
    const request = yield* Deferred.await(h.requested);
    expect(h.runs).toEqual([]);
    expect(request.operation).toBe("run_scheduled_task_now");
    expect(request.summary).toContain("Inspect the release");
    expect(request.summary).toContain("chosen-model");
    expect(request.summary).toContain("runtimeMode: auto");
    expect(request.summary.includes("private-value")).toBe(false);
    expect(request.targetDescription).toContain("full-access/default");
    yield* Deferred.succeed(h.approved, undefined);
    expect(yield* Fiber.join(fiber)).toMatchObject({ taskId: h.saved.id });
    expect(h.runs).toEqual([{ id: h.saved.id, expectedTask: h.saved }]);
    expect(h.limit()?.approvedTargets).toEqual([
      { threadId: ThreadId.make("target"), runtimeMode: "full-access", interactionMode: "default" },
    ]);
  }),
);

for (const changed of ["caller", "target"] as const) {
  it.effect(`rejects scheduled execution if the ${changed} mode changes while approval waits`, () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const fiber = yield* h.call.pipe(Effect.forkChild);
      yield* Deferred.await(h.requested);
      if (changed === "caller") h.setCallerMode("full-access");
      else h.setTargetMode("auto");
      yield* Deferred.succeed(h.approved, undefined);
      expect(yield* Fiber.join(fiber)).toMatchObject({ code: "capability_denied" });
      expect(h.runs).toEqual([]);
    }),
  );
}

it.effect("preserves direct scheduled execution for full-access callers", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.setCallerMode("full-access");
    expect(yield* h.call).toMatchObject({ taskId: h.saved.id });
    expect(h.runs).toEqual([{ id: h.saved.id }]);
  }),
);
