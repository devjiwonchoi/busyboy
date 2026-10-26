import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { CuaDriverLike } from "@trycua/cua-driver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ComputerUseDriver from "./ComputerUseDriver.ts";

interface FakeWorkers {
  readonly started: Array<ComputerUseDriver.ComputerUseWorkerSpec>;
  readonly shutdowns: { count: number };
  readonly factory: ComputerUseDriver.ComputerUseWorkerFactory;
}

function fakeWorkers(options?: { readonly failStart?: boolean }): FakeWorkers {
  const started: Array<ComputerUseDriver.ComputerUseWorkerSpec> = [];
  const shutdowns = { count: 0 };
  const factory: ComputerUseDriver.ComputerUseWorkerFactory = async (spec) => {
    started.push(spec);
    if (options?.failStart) throw new Error("spawn failed");
    return {
      id: started.length,
      shutdown: async () => {
        shutdowns.count += 1;
      },
    } as unknown as CuaDriverLike;
  };
  return { started, shutdowns, factory };
}

const workerId = (worker: CuaDriverLike) => (worker as unknown as { readonly id: number }).id;

/** Builds the service in its own scope so tests can check what closing it does. */
const makeDriver = (
  fakes: FakeWorkers,
  options?: { readonly driverPath?: string | undefined; readonly platform?: NodeJS.Platform },
) =>
  Effect.gen(function* () {
    const base = yield* ServerConfig.ServerConfig;
    const scope = yield* Scope.make();
    const driver = yield* ComputerUseDriver.make(fakes.factory).pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...base,
        computerUseDriverPath:
          options && "driverPath" in options ? options.driverPath : "/opt/cua driver's/cua-driver",
        computerUseHostBundleId: "dev.jiwon.busyboy.computer-use",
      }),
      Effect.provideService(HostProcess.Platform, options?.platform ?? "darwin"),
      Scope.provide(scope),
    );
    return { driver, scope, stateDir: base.stateDir };
  });

const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "computer-use-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("ComputerUseDriver", () => {
  it.effect("is unavailable without a desktop-provided driver or off macOS", () =>
    Effect.gen(function* () {
      for (const options of [{ driverPath: undefined }, { platform: "linux" as const }]) {
        const fakes = fakeWorkers();
        const { driver } = yield* makeDriver(fakes, options);
        assert.isFalse(driver.available);
        const exit = yield* Effect.exit(driver.withWorker(() => Effect.void));
        assert.isTrue(Exit.isFailure(exit));
        assert.match(String(exit), /ComputerUseUnavailableError/);
        assert.lengthOf(fakes.started, 0);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("has Busyboy Computer Use ask macOS for its permissions, once", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const runner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.sync(() => {
            runs.push(input);
            return { stdout: "", stderr: "", code: 0 } as never;
          }),
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const { driver, stateDir } = yield* makeDriver(fakeWorkers()).pipe(Effect.provide(runner));
      const path = yield* Path.Path;
      const launcherPath = path.join(stateDir, "computer-use", "cua-driver-launcher");

      yield* driver.requestPermissions;
      yield* driver.requestPermissions;

      assert.deepStrictEqual(
        runs.map(({ command, args }) => ({ command, args })),
        [{ command: launcherPath, args: ["--request-permissions"] }],
      );
      assert.include(yield* fileSystem.readFileString(launcherPath), "exec ");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("starts one worker lazily and reuses it across concurrent calls", () =>
    Effect.gen(function* () {
      const fakes = fakeWorkers();
      const { driver, stateDir } = yield* makeDriver(fakes);
      const path = yield* Path.Path;
      assert.lengthOf(fakes.started, 0);

      const ids = yield* Effect.forEach(
        [1, 2, 3],
        () => driver.withWorker((worker) => Effect.succeed(workerId(worker))),
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(ids, [1, 1, 1]);
      assert.deepStrictEqual(fakes.started, [
        {
          launcherPath: path.join(stateDir, "computer-use", "cua-driver-launcher"),
          hostBundleId: "dev.jiwon.busyboy.computer-use",
        },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("writes a private launcher that disables telemetry and display-awake by default", () =>
    Effect.gen(function* () {
      const fakes = fakeWorkers();
      const { driver, stateDir } = yield* makeDriver(fakes);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* driver.withWorker(() => Effect.void);

      const launcherPath = path.join(stateDir, "computer-use", "cua-driver-launcher");
      const script = yield* fileSystem.readFileString(launcherPath);
      const stat = yield* fileSystem.stat(launcherPath);
      assert.strictEqual(stat.mode & 0o777, 0o700);
      assert.include(script, "export DO_NOT_TRACK=1");
      assert.include(script, "export CUA_TELEMETRY_ENABLED=false");
      assert.include(script, "export CUA_DRIVER_RS_UPDATE_CHECK=false");
      assert.include(script, "export CUA_DRIVER_KEEP_DISPLAY_AWAKE=0");
      assert.include(
        script,
        `export CUA_DRIVER_RS_HOME='${path.join(stateDir, "computer-use", "driver-home")}'`,
      );
      assert.include(script, `exec '/opt/cua driver'\\''s/cua-driver' "$@"`);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("restarts the worker when keep-display-awake changes, and not otherwise", () =>
    Effect.gen(function* () {
      const fakes = fakeWorkers();
      const { driver, stateDir } = yield* makeDriver(fakes);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* driver.withWorker(() => Effect.void);

      yield* driver.setKeepDisplayAwake(false);
      assert.strictEqual(fakes.shutdowns.count, 0);

      yield* driver.setKeepDisplayAwake(true);
      assert.strictEqual(fakes.shutdowns.count, 1);
      const id = yield* driver.withWorker((worker) => Effect.succeed(workerId(worker)));
      assert.strictEqual(id, 2);
      const script = yield* fileSystem.readFileString(
        path.join(stateDir, "computer-use", "cua-driver-launcher"),
      );
      assert.include(script, "export CUA_DRIVER_KEEP_DISPLAY_AWAKE=600");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("restart stops the worker and the next call starts a new one", () =>
    Effect.gen(function* () {
      const fakes = fakeWorkers();
      const { driver } = yield* makeDriver(fakes);

      yield* driver.restart;
      assert.strictEqual(fakes.shutdowns.count, 0);

      yield* driver.withWorker(() => Effect.void);
      yield* driver.restart;
      assert.strictEqual(fakes.shutdowns.count, 1);
      const id = yield* driver.withWorker((worker) => Effect.succeed(workerId(worker)));
      assert.strictEqual(id, 2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shuts the worker down when the service scope closes", () =>
    Effect.gen(function* () {
      const fakes = fakeWorkers();
      const { driver, scope } = yield* makeDriver(fakes);
      yield* driver.withWorker(() => Effect.void);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(fakes.shutdowns.count, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports a start failure and tries again on the next call", () =>
    Effect.gen(function* () {
      const fakes = fakeWorkers({ failStart: true });
      const { driver } = yield* makeDriver(fakes);

      const first = yield* Effect.exit(driver.withWorker(() => Effect.void));
      const second = yield* Effect.exit(driver.withWorker(() => Effect.void));
      assert.match(String(first), /ComputerUseDriverStartError/);
      assert.isTrue(Exit.isFailure(second));
      assert.lengthOf(fakes.started, 2);
    }).pipe(Effect.provide(TestLayer)),
  );
});
