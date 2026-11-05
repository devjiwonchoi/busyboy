import {
  DEFAULT_PROJECT_TEAM_SETTINGS,
  EnvironmentId,
  ProjectAttentionBatchId,
  ProjectId,
  ProjectSitrepId,
  ThreadId,
  WS_METHODS,
  type ProjectTeamAttentionSnapshot,
  type ProjectTeamAttentionSummary,
  type ProjectTeamRequestSitrepInput,
  type ProjectTeamUpdateSettingsInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createProjectTeamEnvironmentAtoms,
  type ProjectTeamAttentionIndex,
} from "./projectTeam.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const ALPHA = ProjectId.make("project-alpha");
const BETA = ProjectId.make("project-beta");

function summary(
  projectId: ProjectId,
  overrides: Partial<ProjectTeamAttentionSummary> = {},
): ProjectTeamAttentionSummary {
  return {
    projectId,
    pmThreadId: ThreadId.make(`pm-${projectId}`),
    openCount: 0,
    latestBatchId: null,
    latestSitrepId: null,
    unreadSitrepCount: 0,
    sitrepInProgress: false,
    settings: DEFAULT_PROJECT_TEAM_SETTINGS,
    persona: { name: "Remy", avatar: { kind: "emoji", emoji: "🦝" }, voice: "chill" },
    enabled: true,
    presence: {
      running: 0,
      waitingOnUser: 0,
      stalled: 0,
      inbox: 0,
      nextSitrepAt: null,
      lastAction: null,
    },
    decisionCards: [],
    tasks: [],
    ...overrides,
  };
}

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeAtoms = Effect.fn(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms: createProjectTeamEnvironmentAtoms(runtime), registry };
});

describe("project team environment atoms", () => {
  it.effect("indexes each attention snapshot by project and by PM thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshots = yield* Queue.unbounded<ProjectTeamAttentionSnapshot>();
        const client = {
          [WS_METHODS.projectTeamSubscribeAttention]: () => Stream.fromQueue(snapshots),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeAtoms(client);
        const atom = atoms.attention({ environmentId: TARGET.environmentId, input: {} });

        const seen = yield* Queue.unbounded<ProjectTeamAttentionIndex>();
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(seen, result.value);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        yield* Queue.offer(snapshots, { projects: [summary(ALPHA)] });
        const first = yield* Queue.take(seen);
        expect([...first.byProjectId.keys()]).toEqual([ALPHA]);
        expect(first.byPmThreadId.get(ThreadId.make("pm-project-alpha"))?.projectId).toBe(ALPHA);

        const batchId = ProjectAttentionBatchId.make("batch-1");
        const sitrepId = ProjectSitrepId.make("sitrep-1");
        yield* Queue.offer(snapshots, {
          projects: [
            summary(ALPHA, {
              openCount: 2,
              latestBatchId: batchId,
              latestSitrepId: sitrepId,
              unreadSitrepCount: 1,
              sitrepInProgress: true,
            }),
            summary(BETA),
          ],
        });
        const second = yield* Queue.take(seen);
        expect(second.byProjectId.get(ALPHA)).toMatchObject({
          openCount: 2,
          latestBatchId: batchId,
          latestSitrepId: sitrepId,
          unreadSitrepCount: 1,
          sitrepInProgress: true,
        });
        expect(second.byPmThreadId.has(ThreadId.make("pm-project-beta"))).toBe(true);
        expect(second.byPmThreadId.has(ThreadId.make("some-other-thread"))).toBe(false);
      }),
    ),
  );

  it.effect("sends sitrep requests and settings updates for the given project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sitrepRequested = yield* Deferred.make<ProjectTeamRequestSitrepInput>();
        const settingsUpdated = yield* Deferred.make<ProjectTeamUpdateSettingsInput>();
        const client = {
          [WS_METHODS.projectTeamRequestSitrep]: (input: ProjectTeamRequestSitrepInput) =>
            Deferred.succeed(sitrepRequested, input).pipe(
              Effect.as({ sitrepId: ProjectSitrepId.make("sitrep-2") }),
            ),
          [WS_METHODS.projectTeamUpdateSettings]: (input: ProjectTeamUpdateSettingsInput) =>
            Deferred.succeed(settingsUpdated, input).pipe(
              Effect.as({
                projectId: input.projectId,
                settings: { ...DEFAULT_PROJECT_TEAM_SETTINGS, sitrepIntervalMinutes: 45 },
              }),
            ),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeAtoms(client);

        const sitrep = yield* Effect.promise(() =>
          atoms.requestSitrep.run(registry, {
            environmentId: TARGET.environmentId,
            input: { projectId: ALPHA },
          }),
        );
        expect(AsyncResult.isSuccess(sitrep) && sitrep.value.sitrepId).toBe("sitrep-2");
        expect(yield* Deferred.await(sitrepRequested)).toEqual({ projectId: ALPHA });

        const updated = yield* Effect.promise(() =>
          atoms.updateSettings.run(registry, {
            environmentId: TARGET.environmentId,
            input: { projectId: ALPHA, sitrepIntervalMinutes: 45 },
          }),
        );
        expect(AsyncResult.isSuccess(updated) && updated.value.settings.sitrepIntervalMinutes).toBe(
          45,
        );
        expect(yield* Deferred.await(settingsUpdated)).toEqual({
          projectId: ALPHA,
          sitrepIntervalMinutes: 45,
        });
      }),
    ),
  );
});
