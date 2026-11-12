import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OperationPermissionStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for permission records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "operation-permission-record" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const start = Effect.fn("test.startPermissionRun")(function* (label: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:permission:${label}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${label}`),
    threadId,
    projectId: ProjectId.make("project:operation-permission"),
    title: label,
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${label}`),
    threadId,
    messageId: MessageId.make(`message:${label}`),
    text: "Request one operation",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
  const now = yield* DateTime.now;
  const record = {
    type: "operation_permission.record" as const,
    commandId: CommandId.make(`pending:${label}`),
    threadId,
    runId: run.id,
    nodeId: run.rootNodeId!,
    turnItemId: TurnItemId.make(`permission:${label}`),
    operation: "thread.send",
    summary: "Send one message",
    reason: "The target has broader permissions",
    targetDescription: "Target thread",
    fingerprint: `fingerprint:${label}`,
    expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
    permissionStatus: "pending" as OperationPermissionStatus,
  };
  const readStatus = projections.getThreadRecords(threadId, ["turnItems"]).pipe(
    Effect.map((records) => {
      const item = records.turnItems.find((item) => item.id === record.turnItemId);
      return item?.type === "operation_permission" ? item.permissionStatus : undefined;
    }),
  );
  const transition = (status: OperationPermissionStatus, suffix?: string) =>
    orchestrator.dispatch({
      ...record,
      commandId: CommandId.make(`${status}:${label}:${suffix ?? "first"}`),
      permissionStatus: status,
    });
  return { orchestrator, projections, record, run, readStatus, transition };
});

it.layer(layerTest)("Operation permission records", (it) => {
  it.effect("persists each permitted transition and keeps a consumed approval single-use", () =>
    Effect.gen(function* () {
      const context = yield* start("lifecycle");
      yield* context.orchestrator.dispatch(context.record);
      assert.equal(yield* context.readStatus, "pending");
      yield* context.transition("approved");
      assert.equal(yield* context.readStatus, "approved");
      const consumes = yield* Effect.all(
        ["one", "two"].map((suffix) => Effect.exit(context.transition("consumed", suffix))),
        { concurrency: 2 },
      );
      assert.equal(consumes.filter((exit) => exit._tag === "Success").length, 1);
      assert.equal(consumes.filter((exit) => exit._tag === "Failure").length, 1);
      assert.equal(yield* context.readStatus, "consumed");
      yield* context.transition("succeeded");
      assert.equal(yield* context.readStatus, "succeeded");
      assert.equal((yield* Effect.exit(context.transition("approved", "reopen")))._tag, "Failure");
      assert.equal(yield* context.readStatus, "succeeded");
    }),
  );

  it.effect("rejects consumption and successful completion before approval", () =>
    Effect.gen(function* () {
      const context = yield* start("skip-approval");
      yield* context.orchestrator.dispatch(context.record);
      for (const status of ["consumed", "succeeded", "failed"] as const) {
        assert.equal((yield* Effect.exit(context.transition(status)))._tag, "Failure");
        assert.equal(yield* context.readStatus, "pending");
      }
      yield* context.transition("declined");
      assert.equal((yield* Effect.exit(context.transition("approved")))._tag, "Failure");
      assert.equal(yield* context.readStatus, "declined");
    }),
  );

  it.effect("rejects changed operation details and another run using the same request", () =>
    Effect.gen(function* () {
      const context = yield* start("immutable");
      yield* context.orchestrator.dispatch(context.record);
      for (const [key, value] of [
        ["fingerprint", "different-fingerprint"],
        ["operation", "project.delete"],
        ["summary", "Different operation"],
        ["reason", "Different reason"],
        ["targetDescription", "Different target"],
        ["expiresAt", "2099-01-01T00:00:00.000Z"],
      ] as const) {
        const attempt = {
          ...context.record,
          commandId: CommandId.make(`changed:${key}`),
          permissionStatus: "approved" as const,
          [key]: value,
        };
        assert.equal((yield* Effect.exit(context.orchestrator.dispatch(attempt)))._tag, "Failure");
      }
      const now = yield* DateTime.now;
      const otherRunId = RunId.make("run:permission:other");
      yield* context.projections.apply({
        id: EventId.make("event:permission:other-run"),
        type: "run.updated",
        threadId: context.record.threadId,
        occurredAt: now,
        payload: { ...context.run, id: otherRunId, ordinal: context.run.ordinal + 1 },
      });
      const otherRun = {
        ...context.record,
        commandId: CommandId.make("approved:other-run"),
        runId: otherRunId,
        permissionStatus: "approved" as const,
      };
      assert.equal((yield* Effect.exit(context.orchestrator.dispatch(otherRun)))._tag, "Failure");
      assert.equal(yield* context.readStatus, "pending");
    }),
  );

  it.effect("does not overwrite a turn item of another type", () =>
    Effect.gen(function* () {
      const context = yield* start("type-collision");
      yield* context.orchestrator.dispatch({
        type: "secret_request.record",
        commandId: CommandId.make("secret:type-collision"),
        threadId: context.record.threadId,
        runId: context.record.runId,
        nodeId: context.record.nodeId,
        turnItemId: context.record.turnItemId,
        label: "Credential",
        reason: "Ask for a credential",
        secretStatus: "pending",
      });
      assert.equal(
        (yield* Effect.exit(context.orchestrator.dispatch(context.record)))._tag,
        "Failure",
      );
      const records = yield* context.projections.getThreadRecords(context.record.threadId, [
        "turnItems",
      ]);
      assert.equal(
        records.turnItems.find((item) => item.id === context.record.turnItemId)?.type,
        "secret_request",
      );
    }),
  );

  it.effect("refuses approval and consumption after expiry", () =>
    Effect.gen(function* () {
      const pending = yield* start("expired-pending");
      const approved = yield* start("expired-approved");
      yield* pending.orchestrator.dispatch(pending.record);
      yield* approved.orchestrator.dispatch(approved.record);
      yield* approved.transition("approved");
      yield* TestClock.adjust("61 seconds");
      assert.equal((yield* Effect.exit(pending.transition("approved")))._tag, "Failure");
      assert.equal((yield* Effect.exit(approved.transition("consumed")))._tag, "Failure");
      yield* pending.transition("expired");
      yield* approved.transition("expired");
      assert.equal(yield* pending.readStatus, "expired");
      assert.equal(yield* approved.readStatus, "expired");
    }),
  );

  it.effect("does not open or consume a permission after its run stopped", () =>
    Effect.gen(function* () {
      const context = yield* start("stopped-run");
      yield* context.orchestrator.dispatch(context.record);
      yield* context.transition("approved");
      const now = yield* DateTime.now;
      yield* context.projections.apply({
        id: EventId.make("event:permission:run-stopped"),
        type: "run.updated",
        threadId: context.record.threadId,
        occurredAt: now,
        payload: { ...context.run, status: "completed", completedAt: now },
      });
      assert.equal((yield* Effect.exit(context.transition("consumed")))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(
          context.orchestrator.dispatch({
            ...context.record,
            commandId: CommandId.make("pending:after-stop"),
            turnItemId: TurnItemId.make("permission:after-stop"),
          }),
        ))._tag,
        "Failure",
      );
      yield* context.transition("cancelled");
      assert.equal(yield* context.readStatus, "cancelled");
    }),
  );
});
