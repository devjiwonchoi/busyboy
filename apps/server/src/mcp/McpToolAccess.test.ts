import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  DispatchModeLimit,
  type DispatchModeLimitValue,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as OperationPermissions from "../permissions/OperationPermissions.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const planThreadId = ThreadId.make("thread:plan");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const backgroundThreadId = ThreadId.make("thread:background");
const oldProviderThreadId = ThreadId.make("thread:old-provider-background");
const archivedThreadId = ThreadId.make("thread:archived-background");
const unknownOwnerThreadId = ThreadId.make("thread:unknown-background-owner");

const backgroundShell = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  pendingBackgroundTasks: [
    { taskId: "task:background", kind: "subagent" as const, providerInstanceId },
  ],
});

const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    planThreadId,
    liveThreadShell(planThreadId, { runtimeMode: "approval-required", interactionMode: "plan" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [backgroundThreadId, backgroundShell(backgroundThreadId, ProviderInstanceId.make("codex"))],
  [oldProviderThreadId, backgroundShell(oldProviderThreadId, ProviderInstanceId.make("claude"))],
  [
    archivedThreadId,
    {
      ...backgroundShell(archivedThreadId, ProviderInstanceId.make("codex")),
      archivedAt: liveThreadShell(archivedThreadId).updatedAt,
    },
  ],
  [
    unknownOwnerThreadId,
    {
      ...liveThreadShell(unknownOwnerThreadId, { activeRunId: null }),
      pendingBackgroundTasks: [{ taskId: "task:unknown", kind: "subagent" as const }],
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_as_caller", probe),
  Tool.make("acts_as_caller", probe),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", {
    ...probe,
    parameters: Schema.Struct({
      runtimeMode: Schema.optional(RuntimeMode),
      interactionMode: Schema.optional(ProviderInteractionMode),
    }),
  }),
  Tool.make("writes_environment", probe),
);
const ran = Effect.succeed({ ran: "ran" });
const probeHandlers: McpToolAccess.Handlers<typeof ProbeToolkit.tools> = {
  reads: McpToolAccess.reads(() => ran),
  reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
  acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
  writes: McpToolAccess.writes(() => ran),
  writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
  writes_threads: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  starts_threads: McpToolAccess.startsThreads(
    (input) => input,
    (_, modes) => Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` }),
  ),
  writes_environment: McpToolAccess.writesEnvironment(() => ran),
};
const layerProbeHandlers = McpToolAccess.toLayer(ProbeToolkit, probeHandlers);

const unchecked = () => ran;

// `@ts-expect-error` fails the build if one ever compiles. Never called.
export const refusedAtCompileTime = () => {
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a handler that skips its declaration
    reads: unchecked,
  });
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a declaration's fields copied onto an unchecked handler
    reads: Object.assign(
      unchecked,
      McpToolAccess.reads(() => ran),
    ),
  });
  // @ts-expect-error a declaration built outside McpToolAccess
  McpToolAccess.Declaration.make(unchecked);
  // @ts-expect-error a declaration constructed directly
  new McpToolAccess.Declaration(unchecked);
  // @ts-expect-error a handlers layer built outside McpToolAccess
  McpToolAccess.HandlersLayer.make(Layer.empty);
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    // @ts-expect-error a handlers layer that skipped `McpToolAccess.toLayer`
    ProbeToolkit.toLayer({
      reads: unchecked,
      reads_as_caller: unchecked,
      acts_as_caller: unchecked,
      writes: unchecked,
      writes_with_capability: unchecked,
      writes_threads: unchecked,
      starts_threads: unchecked,
      writes_environment: unchecked,
    }),
  );
};

const probeServer = (threads: Layer.Layer<ThreadManagement.ThreadManagementService>) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threads),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const plan = threadCaller(planThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
// Its turn ended, but a background subagent it started still runs.
const background = threadCaller(backgroundThreadId);
const oldProviderBackground = threadCaller(oldProviderThreadId);
const archivedBackground = threadCaller(archivedThreadId);
const unknownOwnerBackground = threadCaller(unknownOwnerThreadId);
const mismatchedProvider = {
  ...background,
  thread: { ...background.thread!, providerInstanceId: ProviderInstanceId.make("claude") },
};
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
const previewOnly = { ...fullAccess, capabilities: new Set(["preview"] as const) };

it.effect.each([
  ["reads", ended, {}, "ran"],
  ["reads", supervisedClient, {}, "ran"],
  ["reads", readOnlyClient, {}, "ran"],

  ["writes", readOnlyClient, {}, "capability_denied"],
  ["writes_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", readOnlyClient, {}, "capability_denied"],
  ["writes_environment", readOnlyClient, {}, "capability_denied"],

  ["reads_as_caller", ended, {}, "ran"],
  ["reads_as_caller", fullAccessClient, {}, "thread_credential_required"],
  ["acts_as_caller", supervised, {}, "ran"],
  ["acts_as_caller", ended, {}, "parent_not_active"],
  ["acts_as_caller", background, {}, "ran"],
  ["acts_as_caller", oldProviderBackground, {}, "parent_not_active"],
  ["acts_as_caller", mismatchedProvider, {}, "parent_not_active"],
  ["acts_as_caller", archivedBackground, {}, "parent_not_active"],
  ["acts_as_caller", unknownOwnerBackground, {}, "parent_not_active"],
  ["acts_as_caller", fullAccessClient, {}, "thread_credential_required"],

  ["writes", supervised, {}, "ran"],
  ["writes", ended, {}, "parent_not_active"],
  ["writes", background, {}, "ran"],
  ["writes", oldProviderBackground, {}, "parent_not_active"],
  ["writes", supervisedClient, {}, "ran"],
  ["writes", previewOnly, {}, "capability_denied"],
  ["writes_environment", previewOnly, {}, "capability_denied"],

  ["writes_with_capability", previewOnly, {}, "ran"],
  ["writes_with_capability", readOnlyClient, {}, "capability_denied"],
  ["writes_with_capability", ended, {}, "parent_not_active"],

  ["writes_threads", supervised, {}, "ran"],
  ["writes_threads", supervised, { threadId: planThreadId }, "ran"],
  [
    "writes_threads",
    supervised,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", plan, { threadId: supervisedThreadId }, "interaction_mode_escalation_denied"],
  ["writes_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", ended, { threadId: supervisedThreadId }, "parent_not_active"],
  ["writes_threads", supervisedClient, { threadId: supervisedThreadId }, "ran"],
  [
    "writes_threads",
    supervisedClient,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", supervised, { threadId: "thread:missing" }, "ran"],

  ["starts_threads", supervised, {}, "approval-required/default"],
  ["starts_threads", supervised, { runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
  ["starts_threads", plan, {}, "approval-required/plan"],
  ["starts_threads", plan, { interactionMode: "default" }, "interaction_mode_escalation_denied"],
  ["starts_threads", fullAccess, { runtimeMode: "auto", interactionMode: "plan" }, "auto/plan"],
  ["starts_threads", ended, {}, "parent_not_active"],
  ["starts_threads", supervisedClient, {}, "approval-required/default"],
  ["starts_threads", supervisedClient, { runtimeMode: "auto" }, "runtime_mode_escalation_denied"],
  ["starts_threads", fullAccessClient, { runtimeMode: "full-access" }, "full-access/default"],

  ["writes_environment", fullAccess, {}, "ran"],
  ["writes_environment", supervised, {}, "capability_denied"],
  ["writes_environment", plan, {}, "capability_denied"],
  ["writes_environment", fullAccessClient, {}, "ran"],
  ["writes_environment", supervisedClient, {}, "capability_denied"],
] as const)("%s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
      ),
    ),
  ),
);

it("refuses a declaration or handlers layer built outside McpToolAccess", () => {
  expect(() => Reflect.construct(McpToolAccess.Declaration, [unchecked])).toThrow(TypeError);
  expect(() => Reflect.construct(McpToolAccess.HandlersLayer, [Layer.empty])).toThrow(TypeError);
});

it("refuses a declaration or handlers layer that only wears another's fields", () => {
  const copiedDeclaration = Object.assign(
    unchecked,
    McpToolAccess.reads(() => ran),
  );
  expect(() =>
    McpToolAccess.toLayer(ProbeToolkit, {
      ...probeHandlers,
      // @ts-expect-error a declaration's fields copied onto an unchecked handler
      reads: copiedDeclaration,
    }),
  ).toThrow(TypeError);
  const copiedLayer = Object.assign(Layer.empty, layerProbeHandlers);
  expect(() => McpToolAccess.HandlersLayer.layer(copiedLayer)).toThrow(TypeError);
});

it.effect("refuses a change when the calling thread cannot be read", () =>
  call("writes", supervised).pipe(
    Effect.map((outcome) => expect(outcome).toBe("orchestration_error")),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" })),
        }),
      ),
    ),
  ),
);

function permissionProbe() {
  const callerId = ThreadId.make("thread:permission-probe-caller");
  const targetId = ThreadId.make("thread:permission-probe-target");
  const caller = threadCaller(callerId);
  const targets = new Map([
    [callerId, liveThreadShell(callerId, { runtimeMode: "auto" })],
    [targetId, liveThreadShell(targetId)],
  ]);
  const cards = new Map<
    string,
    Extract<OrchestrationV2ServerCommand, { type: "operation_permission.record" }>
  >();
  let question = "Publish the release?";
  let writes = 0;
  let dispatchLimit: DispatchModeLimitValue | undefined;
  const management = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.sync(() => targets.get(id) ?? null),
    getThreadRecords: () =>
      Effect.sync(
        () =>
          ({
            thread: targets.get(callerId),
            runs: [
              {
                id: "run:permission-probe",
                ordinal: 1,
                status: "running",
                rootNodeId: "node:permission-probe",
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerThreadId: "provider-thread:permission-probe",
              },
            ],
            providerThreads: [
              {
                id: "provider-thread:permission-probe",
                providerSessionId: caller.thread!.providerSessionId,
              },
            ],
          }) as never,
      ),
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type === "operation_permission.record") {
          cards.set(command.turnItemId, command);
        }
        return {} as never;
      }),
  });
  const write = Effect.gen(function* () {
    dispatchLimit = yield* DispatchModeLimit;
    writes += 1;
    return { ran: "ran" };
  });
  const toolkit = Toolkit.make(
    Tool.make("approved_thread_write", {
      ...probe,
      parameters: Schema.Struct({ threadId: ThreadId }),
    }),
    Tool.make("approved_environment_write", probe),
  );
  const handlers = McpToolAccess.toLayer(toolkit, {
    approved_thread_write: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      () => write,
      "test.thread.write",
      { snapshot: () => Effect.sync(() => ({ questions: [question] })) },
    ),
    approved_environment_write: McpToolAccess.writesEnvironment(() => write, {
      operation: "test.environment.update",
    }),
  });
  const server = McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(management),
  );
  const permissionsServer = server.pipe(
    Layer.provideMerge(OperationPermissions.layer.pipe(Layer.provide(management))),
  );
  const pendingCard = Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const card = [...cards.values()].find((item) => item.permissionStatus === "pending");
      if (card !== undefined) {
        return card.turnItemId;
      }
      yield* Effect.yieldNow;
    }
    throw new Error("The MCP wrapper did not open a permission card.");
  });
  return {
    changeQuestion: () => {
      question = "Delete the release?";
    },
    callerId,
    targetId,
    caller,
    cards,
    targets,
    server,
    permissionsServer,
    pendingCard,
    writes: () => writes,
    dispatchLimit: () => dispatchLimit,
  };
}

for (const tool of ["approved_thread_write", "approved_environment_write"] as const) {
  it.effect(`waits for a direct user approval before executing ${tool}`, () => {
    const h = permissionProbe();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions.OperationPermissions;
      const fiber = yield* call(
        tool,
        h.caller,
        tool === "approved_thread_write" ? { threadId: h.targetId } : {},
      ).pipe(Effect.forkChild);
      const turnItemId = yield* h.pendingCard;
      expect(h.writes()).toBe(0);
      yield* permissions.answer({ threadId: h.callerId, turnItemId, decision: "allow" });
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("ran");
      expect(h.writes()).toBe(1);
      expect(h.cards.get(turnItemId)?.permissionStatus).toBe("succeeded");
      expect(h.targets.get(h.callerId)?.runtimeMode).toBe("auto");
      if (tool === "approved_thread_write") {
        expect(h.dispatchLimit()?.runtimeMode).toBe("auto");
        expect(h.dispatchLimit()?.approvedTargets).toEqual([
          {
            threadId: h.targetId,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        ]);
      }
    }).pipe(Effect.provide(h.permissionsServer));
  });

  it.effect(`does not execute ${tool} when the user declines`, () => {
    const h = permissionProbe();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions.OperationPermissions;
      const fiber = yield* call(
        tool,
        h.caller,
        tool === "approved_thread_write" ? { threadId: h.targetId } : {},
      ).pipe(Effect.forkChild);
      const turnItemId = yield* h.pendingCard;
      yield* permissions.answer({ threadId: h.callerId, turnItemId, decision: "deny" });
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("capability_denied");
      expect(h.writes()).toBe(0);
      expect(h.cards.get(turnItemId)?.permissionStatus).toBe("declined");
    }).pipe(Effect.provide(h.permissionsServer));
  });

  it.effect(`does not execute ${tool} without the permission service`, () => {
    const h = permissionProbe();
    return call(
      tool,
      h.caller,
      tool === "approved_thread_write" ? { threadId: h.targetId } : {},
    ).pipe(
      Effect.map((outcome) => {
        expect(outcome).toBe("capability_denied");
        expect(h.writes()).toBe(0);
        expect(h.cards.size).toBe(0);
      }),
      Effect.provide(h.server),
    );
  });
}

for (const changed of ["caller", "target"] as const) {
  it.effect(`rejects an approved thread write after the ${changed} mode changes`, () => {
    const h = permissionProbe();
    return Effect.gen(function* () {
      const permissions = yield* OperationPermissions.OperationPermissions;
      const fiber = yield* call("approved_thread_write", h.caller, { threadId: h.targetId }).pipe(
        Effect.forkChild,
      );
      const turnItemId = yield* h.pendingCard;
      const changedId = changed === "caller" ? h.callerId : h.targetId;
      h.targets.set(changedId, {
        ...h.targets.get(changedId)!,
        runtimeMode: changed === "caller" ? "full-access" : "auto",
      });
      yield* permissions.answer({ threadId: h.callerId, turnItemId, decision: "allow" });
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("capability_denied");
      expect(h.writes()).toBe(0);
      expect(h.cards.get(turnItemId)?.permissionStatus).toBe("failed");
    }).pipe(Effect.provide(h.permissionsServer));
  });
}

it("shows executable settings and their values while redacting credentials from the approval", () => {
  const summary = McpToolAccess.operationSummary("t3_project_update", {
    projectId: "project:one",
    scripts: [
      { name: "Setup", command: "API_TOKEN=private-value pnpm install", runOnWorktreeCreate: true },
    ],
    defaultModelSelection: { instanceId: "codex", model: "selected-model" },
    backgroundActivity: { profile: "always" },
    sourceControlWritingStyle: { customInstructions: "Authorization: Bearer private-bearer" },
    answers: { secret: "private-answer" },
    token: "private-token",
  });
  expect(summary.includes("pnpm install")).toBe(true);
  expect(summary.includes('"runOnWorktreeCreate": true')).toBe(true);
  expect(summary.includes("selected-model")).toBe(true);
  expect(summary.includes('"profile": "always"')).toBe(true);
  expect(summary.match(/private-(value|bearer|answer|token)/)).toBeNull();
  expect(summary.includes("비밀값 숨김")).toBe(true);
});

it.effect("shows the pending question and rejects approval when its context changes", () => {
  const h = permissionProbe();
  return Effect.gen(function* () {
    const permissions = yield* OperationPermissions.OperationPermissions;
    const fiber = yield* call("approved_thread_write", h.caller, { threadId: h.targetId }).pipe(
      Effect.forkChild,
    );
    const turnItemId = yield* h.pendingCard;
    expect(h.cards.get(turnItemId)?.summary.includes("Publish the release?")).toBe(true);
    h.changeQuestion();
    yield* permissions.answer({ threadId: h.callerId, turnItemId, decision: "allow" });
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe("capability_denied");
    expect(h.writes()).toBe(0);
  }).pipe(Effect.provide(h.permissionsServer));
});

it("shows the proposed answer while masking credential fields", () => {
  const summary = McpToolAccess.operationSummary("t3_pending_request_respond", {
    answers: { release: "Publish version 2", password: "private-password" },
  });
  expect(summary.includes("Publish version 2")).toBe(true);
  expect(summary.includes("private-password")).toBe(false);
});

it("previews attachment identity and transfer context without file contents or upload credentials", () => {
  const summary = McpToolAccess.operationSummary("t3_thread_send_attachments", {
    attachments: [
      {
        id: "file-one",
        type: "file",
        name: "release.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
        url: "https://upload.example/private-upload",
        dataUrl: "private-content",
        source: { accessibleText: "private-screen" },
      },
    ],
    sourceThreadId: "thread:source",
    targetThreadId: "thread:target",
    sourcePoint: { type: "run", runId: "run:approved" },
  });
  for (const value of [
    "release.txt",
    "text/plain",
    "42",
    "file-one",
    "thread:source",
    "thread:target",
    "run:approved",
  ]) {
    expect(summary.includes(value)).toBe(true);
  }
  expect(summary.match(/private-(upload|content|screen)/)).toBeNull();
});
