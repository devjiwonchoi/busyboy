import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectTeam from "./projectTeam/ProjectTeamService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    assert.deepEqual(yield* Ref.get(calls), ["recover", "delegated", "worker", "bootstrap"]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

const bootstrapWelcomeTargets = (managerEnabled: boolean) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("cwd-project");
    const managerThreadId = ThreadId.make("project-pm-1");
    const launchedTitles: string[] = [];
    let managerCreated = false;
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/cwd-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectService.ProjectService, {
        bootstrap: () => Effect.succeed({ project: { id: projectId } }),
      } as never),
      Effect.provideService(ProjectTeam.ProjectTeamService, {
        ensureManager: () =>
          Effect.sync(() => {
            managerCreated = true;
            return { projectId, threadId: managerThreadId, settings: { enabled: managerEnabled } };
          }),
      } as never),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        // A fresh project has no threads until its PM is set up.
        getShellSnapshot: () =>
          Effect.sync(() => ({
            threads: managerCreated ? [{ id: managerThreadId, projectId, lineage: {} }] : [],
          })),
      } as never),
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        launch: (input: { readonly title: string }) =>
          Effect.sync(() => {
            launchedTitles.push(input.title);
            return { threadId: ThreadId.make("starter-thread") };
          }),
      } as never),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as never),
      Effect.provide(Layer.merge(Path.layer, NodeCrypto.layer)),
    );
    return { targets, launchedTitles, projectId, managerThreadId };
  });

it.effect("auto-bootstrap opens the project's PM instead of launching a starter thread", () =>
  Effect.gen(function* () {
    const { targets, launchedTitles, projectId, managerThreadId } =
      yield* bootstrapWelcomeTargets(true);

    assert.deepStrictEqual(launchedTitles, []);
    assert.deepStrictEqual(targets, {
      bootstrapProjectId: projectId,
      bootstrapThreadId: managerThreadId,
    });
  }),
);

it.effect("auto-bootstrap still launches a starter thread when the PM is turned off", () =>
  Effect.gen(function* () {
    const { targets, launchedTitles, projectId } = yield* bootstrapWelcomeTargets(false);

    assert.deepStrictEqual(launchedTitles, ["New thread"]);
    assert.deepStrictEqual(targets, {
      bootstrapProjectId: projectId,
      bootstrapThreadId: ThreadId.make("starter-thread"),
    });
  }),
);
