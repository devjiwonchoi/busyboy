import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "test-model" };
// Claude-like: a steer cuts off the running tools unless it is gentle.
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  turns: {
    ...CodexProviderCapabilitiesV2.turns,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: true,
    supportsQueuedMessages: true,
  },
};

it.effect.each([
  {
    name: "a person's queued message to a busy PM joins its turn gently",
    manager: true,
    createdBy: "user",
    dispatchMode: { type: "queue_after_active" },
    deliveryIntent: undefined,
    steer: "gentle",
  },
  {
    name: "a person's restart request to a busy PM joins its turn gently",
    manager: true,
    createdBy: "user",
    dispatchMode: { type: "queue_after_active" },
    deliveryIntent: "restart",
    steer: "gentle",
  },
  {
    name: "a server wake to a busy PM stays queued",
    manager: true,
    createdBy: "agent",
    dispatchMode: { type: "queue_after_active" },
    deliveryIntent: undefined,
    steer: "none",
  },
  {
    name: "a queued message in another thread stays queued",
    manager: false,
    createdBy: "user",
    dispatchMode: { type: "queue_after_active" },
    deliveryIntent: undefined,
    steer: "none",
  },
  {
    name: "a steer in another thread keeps cutting in",
    manager: false,
    createdBy: "user",
    dispatchMode: { type: "queue_after_active" },
    deliveryIntent: "steer",
    steer: "cutting",
  },
] as const)("$name", ({ manager, createdBy, dispatchMode, deliveryIntent, steer }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("project-manager-steering");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      const steers: Array<ProviderAdapter.ProviderAdapterV2SteerInput> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.sync(() => {
                  steers.push(turn);
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const threadId = ThreadId.make("thread:project-manager-steering");
      const projectId = ProjectId.make("project:project-manager-steering");
      const teamRepository = Layer.mock(ProjectTeamRepository.ProjectTeamRepository)({
        getManagerByThreadId: (candidate) =>
          Effect.succeed(
            manager && candidate === threadId
              ? Option.some({ projectId, threadId } as ProjectTeamRepository.ProjectManagerRecord)
              : Option.none(),
          ),
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Project manager",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "Plan the release.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;

        const messageId = MessageId.make("message:second");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("second"),
          threadId,
          messageId,
          text: "Also check the changelog.",
          attachments: [],
          dispatchMode,
          ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
          createdBy,
          creationSource: createdBy === "user" ? "web" : "server",
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const message = projection.messages.find((candidate) => candidate.id === messageId);
        assert.equal(started.length, 1);
        if (steer === "none") {
          assert.lengthOf(steers, 0);
          assert.notEqual(message?.runId, first.runId);
          assert.equal(projection.runs.find((run) => run.id === message?.runId)?.status, "queued");
          return;
        }
        assert.lengthOf(steers, 1);
        assert.equal(steers[0]?.message.messageId, messageId);
        assert.equal(steers[0]?.gentle, steer === "gentle" ? true : undefined);
        assert.equal(message?.runId, first.runId);
        // Nothing restarted: the run keeps its one attempt.
        assert.lengthOf(
          projection.attempts.filter((attempt) => attempt.runId === first.runId),
          1,
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "project-manager-steering" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ).pipe(Layer.provide(teamRepository)),
        ),
      );
    }),
  ),
);
