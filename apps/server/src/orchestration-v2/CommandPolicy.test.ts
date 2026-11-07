import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { GrokProviderCapabilitiesV2 } from "@t3tools/provider-grok/testing";
import * as CommandPolicy from "./CommandPolicy.ts";

const commandId = CommandId.make("command-policy-test");
const threadId = ThreadId.make("command-policy-thread");
const activeRunId = RunId.make("command-policy-active-run");
const userMessageId = MessageId.make("command-policy-user-message");

const baseCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;

function capabilities(
  override: (current: OrchestrationV2ProviderCapabilities) => OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities {
  return override(baseCapabilities);
}

function dispatchProjection(
  sessionCapabilities?: OrchestrationV2ProviderCapabilities,
): OrchestrationV2ThreadProjection {
  const providerThreadId = ProviderThreadId.make("command-policy-provider-thread");
  const providerSessionId = ProviderSessionId.make("command-policy-provider-session");
  return {
    runs:
      sessionCapabilities === undefined
        ? []
        : [{ id: activeRunId, status: "running", providerThreadId, userMessageId }],
    messages: [{ id: userMessageId, text: "first", attachments: [] }],
    providerThreads:
      sessionCapabilities === undefined ? [] : [{ id: providerThreadId, providerSessionId }],
    providerSessions:
      sessionCapabilities === undefined
        ? []
        : [{ id: providerSessionId, capabilities: sessionCapabilities }],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("resolves automatic message delivery from authoritative provider capabilities", () => {
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "start_immediately" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(baseCapabilities),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "steer_active", targetRunId: activeRunId },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(
        capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsQueuedMessages: true,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      ),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "queue_after_active" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(
        capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsQueuedMessages: false,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      ),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
});

it.each(["preparing", "starting"] as const)(
  "queues an automatic message while the handoff run is %s",
  (status) => {
    const projection = dispatchProjection(baseCapabilities);
    assert.deepEqual(
      CommandPolicy.resolveMessageDispatchIntent(
        { ...projection, runs: projection.runs.map((run) => ({ ...run, status })) },
        { type: "start_immediately" },
        "auto",
      ),
      { type: "queue_after_active" },
    );
  },
);

it("targets the latest active run for explicit steer and restart intent", () => {
  const projection = dispatchProjection(baseCapabilities);
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(projection, { type: "start_immediately" }, "steer"),
    { type: "steer_active", targetRunId: activeRunId },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      projection,
      { type: "start_immediately" },
      "restart",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(),
      { type: "start_immediately" },
      "steer",
    ),
    { type: "start_immediately" },
  );
});

it.each(["/compact", " /LOGOUT "])("queues a steer sent while %s runs", (text) => {
  const projection = dispatchProjection(baseCapabilities);
  const maintenance = {
    ...projection,
    messages: [{ id: userMessageId, text, attachments: [] }],
  } as unknown as OrchestrationV2ThreadProjection;
  for (const deliveryIntent of ["auto", "steer"] as const) {
    assert.deepEqual(
      CommandPolicy.resolveMessageDispatchIntent(
        maintenance,
        { type: "start_immediately" },
        deliveryIntent,
      ),
      { type: "queue_after_active" },
    );
  }
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(maintenance, {
      type: "steer_active",
      targetRunId: activeRunId,
    }),
    { type: "queue_after_active" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      maintenance,
      { type: "start_immediately" },
      "restart",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
});

describe("project manager user messages", () => {
  const runSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
  const busyManager = (
    status: "preparing" | "starting" | "running" | "waiting" = "running",
    sessionCapabilities: OrchestrationV2ProviderCapabilities = baseCapabilities,
  ) => {
    const projection = dispatchProjection(sessionCapabilities);
    return {
      ...projection,
      runs: projection.runs.map((run) => ({
        ...run,
        status,
        modelSelection: runSelection,
        activeAttemptId: "attempt",
      })),
      providerTurns: [{ runAttemptId: "attempt", status: "running" }],
    } as unknown as OrchestrationV2ThreadProjection;
  };

  it.each([
    { type: "queue_after_active" },
    { type: "start_immediately" },
    { type: "steer_active", targetRunId: activeRunId },
    { type: "restart_active", targetRunId: activeRunId },
  ] as const)("joins the running turn gently when the client asks for $type", (mode) => {
    assert.deepEqual(
      CommandPolicy.resolveProjectManagerUserDispatch(busyManager(), mode, runSelection),
      { mode: { type: "steer_active", targetRunId: activeRunId }, gentle: true },
    );
  });

  it("starts a run normally when the manager is idle", () => {
    assert.deepEqual(
      CommandPolicy.resolveProjectManagerUserDispatch(
        dispatchProjection(),
        { type: "start_immediately" },
        runSelection,
      ),
      { mode: { type: "start_immediately" }, gentle: false },
    );
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "queues instead of steering or restarting a %s run",
    (status) => {
      for (const mode of [
        { type: "steer_active", targetRunId: activeRunId },
        { type: "restart_active", targetRunId: activeRunId },
      ] as const) {
        assert.deepEqual(
          CommandPolicy.resolveProjectManagerUserDispatch(busyManager(status), mode, runSelection),
          { mode: { type: "queue_after_active" }, gentle: false },
        );
      }
      assert.deepEqual(
        CommandPolicy.resolveProjectManagerUserDispatch(
          busyManager(status),
          { type: "queue_after_active" },
          runSelection,
        ),
        { mode: { type: "queue_after_active" }, gentle: false },
      );
    },
  );

  it("queues while compaction runs", () => {
    const projection = {
      ...busyManager(),
      messages: [{ id: userMessageId, text: "/compact", attachments: [] }],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.deepEqual(
      CommandPolicy.resolveProjectManagerUserDispatch(
        projection,
        { type: "steer_active", targetRunId: activeRunId },
        runSelection,
      ),
      { mode: { type: "queue_after_active" }, gentle: false },
    );
  });

  it("queues when only a restart could take the message", () => {
    const restartOnly = capabilities((current) => ({
      ...current,
      turns: {
        ...current.turns,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: true,
      },
    }));
    assert.deepEqual(
      CommandPolicy.resolveProjectManagerUserDispatch(
        busyManager("running", restartOnly),
        { type: "restart_active", targetRunId: activeRunId },
        runSelection,
      ),
      { mode: { type: "queue_after_active" }, gentle: false },
    );
  });

  it("queues between turns, when there is no running turn to join", () => {
    const projection = {
      ...busyManager(),
      providerTurns: [{ runAttemptId: "attempt", status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.deepEqual(
      CommandPolicy.resolveProjectManagerUserDispatch(
        projection,
        { type: "start_immediately" },
        runSelection,
      ),
      { mode: { type: "queue_after_active" }, gentle: false },
    );
  });

  it("queues a model change, which could force a restart", () => {
    assert.deepEqual(
      CommandPolicy.resolveProjectManagerUserDispatch(
        busyManager(),
        { type: "steer_active", targetRunId: activeRunId },
        { ...runSelection, model: "sonnet" },
      ),
      { mode: { type: "queue_after_active" }, gentle: false },
    );
  });
});

const layer = it.layer(CommandPolicy.layer);

layer("CommandPolicyV2", (it) => {
  it.effect("prefers direct active steering when the provider supports it", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: baseCapabilities,
      });

      assert.equal(result, "active_steering");
    }),
  );

  it.effect("uses interrupt-and-restart steering when direct steering is unavailable", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsInterrupt: true,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      });

      assert.equal(result, "interrupt_restart");
    }),
  );

  it.effect("uses interrupt-and-restart steering for Grok ACP", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("grok"),
        capabilities: GrokProviderCapabilitiesV2,
      });

      assert.equal(result, "interrupt_restart");
    }),
  );

  it.effect("honors an explicit interrupt-and-restart request", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideSteeringExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: CodexProviderCapabilitiesV2,
        forceRestart: true,
      });

      assert.equal(result, "interrupt_restart");
    }),
  );

  it.effect("reports the actually missing capability across the steering matrix", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;
      const providerInstanceId = ProviderInstanceId.make("codex");
      const fallbackDetail =
        "providerInstanceId cannot steer active turns directly or by interrupt-and-restart";
      const forcedRestartDetail =
        "providerInstanceId cannot satisfy a required interrupt-and-restart";

      const cases: ReadonlyArray<{
        readonly forceRestart: boolean;
        readonly supportsActiveSteering: boolean;
        readonly supportsInterrupt: boolean;
        readonly supportsSteeringByInterruptRestart: boolean;
        readonly expected:
          | { readonly type: "policy"; readonly value: CommandPolicy.SteeringExecutionPolicyV2 }
          | {
              readonly type: "error";
              readonly capability: CommandPolicy.CommandPolicyCapability;
              readonly detail: string;
            };
      }> = [
        {
          forceRestart: false,
          supportsActiveSteering: true,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: false,
          expected: { type: "policy", value: "active_steering" },
        },
        {
          forceRestart: false,
          supportsActiveSteering: true,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: true,
          expected: { type: "policy", value: "active_steering" },
        },
        {
          forceRestart: false,
          supportsActiveSteering: true,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: false,
          expected: { type: "policy", value: "active_steering" },
        },
        {
          forceRestart: false,
          supportsActiveSteering: true,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: true,
          expected: { type: "policy", value: "active_steering" },
        },
        {
          forceRestart: false,
          supportsActiveSteering: false,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: true,
          expected: { type: "policy", value: "interrupt_restart" },
        },
        {
          forceRestart: false,
          supportsActiveSteering: false,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: false,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: fallbackDetail,
          },
        },
        {
          forceRestart: false,
          supportsActiveSteering: false,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: true,
          expected: { type: "error", capability: "active_steering", detail: fallbackDetail },
        },
        {
          forceRestart: false,
          supportsActiveSteering: false,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: false,
          expected: { type: "error", capability: "active_steering", detail: fallbackDetail },
        },
        {
          forceRestart: true,
          supportsActiveSteering: true,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: true,
          expected: { type: "policy", value: "interrupt_restart" },
        },
        {
          forceRestart: true,
          supportsActiveSteering: false,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: true,
          expected: { type: "policy", value: "interrupt_restart" },
        },
        {
          forceRestart: true,
          supportsActiveSteering: true,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: false,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: forcedRestartDetail,
          },
        },
        {
          forceRestart: true,
          supportsActiveSteering: false,
          supportsInterrupt: true,
          supportsSteeringByInterruptRestart: false,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: forcedRestartDetail,
          },
        },
        {
          forceRestart: true,
          supportsActiveSteering: true,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: true,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: forcedRestartDetail,
          },
        },
        {
          forceRestart: true,
          supportsActiveSteering: false,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: true,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: forcedRestartDetail,
          },
        },
        {
          forceRestart: true,
          supportsActiveSteering: true,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: false,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: forcedRestartDetail,
          },
        },
        {
          forceRestart: true,
          supportsActiveSteering: false,
          supportsInterrupt: false,
          supportsSteeringByInterruptRestart: false,
          expected: {
            type: "error",
            capability: "interrupt_restart_steering",
            detail: forcedRestartDetail,
          },
        },
      ];

      for (const entry of cases) {
        const decision = policy.decideSteeringExecution({
          commandId,
          threadId,
          providerInstanceId,
          forceRestart: entry.forceRestart,
          capabilities: capabilities((current) => ({
            ...current,
            turns: {
              ...current.turns,
              supportsActiveSteering: entry.supportsActiveSteering,
              supportsInterrupt: entry.supportsInterrupt,
              supportsSteeringByInterruptRestart: entry.supportsSteeringByInterruptRestart,
            },
          })),
        });

        if (entry.expected.type === "policy") {
          assert.equal(yield* decision, entry.expected.value);
          continue;
        }

        const error = yield* decision.pipe(Effect.flip);
        assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
        assert.equal(error.commandId, commandId);
        assert.equal(error.threadId, threadId);
        assert.equal(error.providerInstanceId, providerInstanceId);
        assert.equal(error.capability, entry.expected.capability);
        assert.equal(error.detail, entry.expected.detail);
      }
    }),
  );

  it.effect("returns typed capability errors for unsupported active steering", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const error = yield* policy
        .decideSteeringExecution({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: capabilities((current) => ({
            ...current,
            turns: {
              ...current.turns,
              supportsActiveSteering: false,
              supportsInterrupt: false,
              supportsSteeringByInterruptRestart: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "active_steering");
    }),
  );

  it.effect("guards native fork behind fork and identity capabilities", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const error = yield* policy
        .ensureNativeFork({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          fromSpecificTurn: true,
          capabilities: capabilities((current) => ({
            ...current,
            identity: {
              ...current.identity,
              nativeThreadIds: "weak",
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "native_fork");
    }),
  );

  it.effect("uses a native fork when the provider supports the requested source point", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: CodexProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        sourceRunStatus: "completed",
        fromSpecificTurn: true,
      });

      assert.equal(result, "native_fork");
    }),
  );

  it.effect("falls back to portable context when Grok ACP cannot fork natively", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("grok"),
        capabilities: GrokProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        sourceRunStatus: "completed",
        fromSpecificTurn: true,
      });

      assert.equal(result, "portable_context");
    }),
  );

  it.effect("returns a typed error when neither native nor portable fork is available", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const error = yield* policy
        .decideForkExecution({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("grok"),
          capabilities: capabilities((current) => ({
            ...current,
            threads: {
              ...current.threads,
              canForkThread: false,
            },
            context: {
              ...current.context,
              canConsumeHandoffSummaries: false,
            },
          })),
          sameProvider: true,
          hasStrongNativeSource: true,
          sourceRunStatus: "completed",
          fromSpecificTurn: true,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "context_handoff");
    }),
  );

  it.effect("guards rollback behind provider rollback snapshot support", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const error = yield* policy
        .ensureRollback({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: capabilities((current) => ({
            ...current,
            checkpointing: {
              ...current.checkpointing,
              providerRollbackReturnsSnapshot: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "rollback_snapshot");
    }),
  );

  it.effect("guards fork-delta handoff behind context handoff capabilities", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const error = yield* policy
        .ensureContextHandoff({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          strategy: "fork_delta_context",
          capabilities: capabilities((current) => ({
            ...current,
            context: {
              ...current.context,
              supportsDeltaHandoff: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "context_handoff");
    }),
  );

  it.effect("guards queued turns behind queued-message support", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const error = yield* policy
        .ensureQueuedMessages({
          commandId,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: capabilities((current) => ({
            ...current,
            turns: {
              ...current.turns,
              supportsQueuedMessages: false,
            },
          })),
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      assert.equal(error.capability, "queued_messages");
    }),
  );
});
