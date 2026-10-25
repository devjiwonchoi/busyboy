import * as NodeEvents from "node:events";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

/** A failed local-app step. Its message is what the update UI shows. */
export class LocalAppUpdateError extends Schema.TaggedError<LocalAppUpdateError>()(
  "LocalAppUpdateError",
  {
    command: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const isLocalAppUpdateError = Schema.is(LocalAppUpdateError);

const decodeCheckReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      currentCommit: Schema.String,
      latestCommit: Schema.String,
      commits: Schema.Array(Schema.String),
    }),
  ),
);
const decodePrepareProgress = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      phase: Schema.String,
      percent: Schema.Number,
      commit: Schema.optionalKey(Schema.String),
    }),
  ),
);

// Runs one local-app.mjs command and hands each stdout line to onLine. The
// script prints its failure reason as the last stderr line before exiting.
const runScript = Effect.fn("desktop.localApp.runScript")(function* (input: {
  readonly nodeCommand: string;
  readonly scriptPath: string;
  readonly command: string;
  readonly onLine: (line: string) => void;
}): Effect.fn.Return<void, LocalAppUpdateError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.nodeCommand, [input.scriptPath, input.command], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      return yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => Effect.sync(() => input.onLine(line))),
          ),
        ],
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(
    Effect.mapError(
      (cause) => new LocalAppUpdateError({ command: input.command, detail: cause.message }),
    ),
  );

  if (exitCode !== 0) {
    const detail =
      stderr.trim().split("\n").at(-1) || `local-app ${input.command} exited ${exitCode}`;
    return yield* new LocalAppUpdateError({ command: input.command, detail });
  }
});

/**
 * An ElectronUpdater for the local app. It drives apps/desktop/scripts/local-app.mjs
 * and reports through the same events electron-updater emits, so DesktopUpdates
 * and the update UI work unchanged: check fetches origin/main, download builds
 * it in the idle slot, and install switches slots and relaunches.
 */
export const make = Effect.fn("desktop.localApp.makeUpdater")(function* (input: {
  readonly nodeCommand: string;
  readonly scriptPath: string;
  readonly baseVersion: string;
  readonly prepareEnvironment: Effect.Effect<void>;
  readonly relaunch: Effect.Effect<void>;
}): Effect.fn.Return<
  ElectronUpdater.ElectronUpdater["Service"],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const events = new NodeEvents.EventEmitter();
  const versionOf = (commit: string) => `${input.baseVersion}+${commit.slice(0, 7)}`;
  const run = (command: string, onLine: (line: string) => void) =>
    input.prepareEnvironment.pipe(
      Effect.andThen(
        runScript({
          nodeCommand: input.nodeCommand,
          scriptPath: input.scriptPath,
          command,
          onLine,
        }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  return ElectronUpdater.ElectronUpdater.of({
    // Feeds, channels and differential downloads do not apply to a source checkout.
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,

    checkForUpdates: Effect.gen(function* () {
      events.emit("checking-for-update");
      const lines: Array<string> = [];
      yield* run("check", (line) => {
        lines.push(line);
      });
      const report = yield* decodeCheckReport(lines.at(-1));

      if (report.latestCommit === report.currentCommit) {
        events.emit("update-not-available");
        return;
      }

      events.emit("update-available", {
        version: versionOf(report.latestCommit),
        releaseNotes: report.commits.map((subject) => `- ${subject}`).join("\n"),
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel: null, cause }),
      ),
    ),

    downloadUpdate: Effect.gen(function* () {
      let builtCommit: string | null = null;
      yield* run("prepare", (line) => {
        const progress = decodePrepareProgress(line);
        if (Option.isNone(progress)) {
          return;
        }

        events.emit("download-progress", { percent: progress.value.percent });
        if (progress.value.commit !== undefined) {
          builtCommit = progress.value.commit;
        }
      });

      if (builtCommit === null) {
        return yield* new LocalAppUpdateError({
          command: "prepare",
          detail: "local-app prepare finished without reporting a commit",
        });
      }

      events.emit("update-downloaded", { version: versionOf(builtCommit) });
    }).pipe(
      Effect.mapError(
        (cause) => new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel: null, cause }),
      ),
    ),

    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      run("switch", () => {}).pipe(
        Effect.andThen(input.relaunch),
        Effect.mapError(
          (cause) =>
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: null,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        ),
      ),

    on: (eventName, listener) => {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
});

/** The local app updates from its source checkout; every other build uses electron-updater. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (Option.isNone(environment.localApp)) {
      return ElectronUpdater.layer;
    }

    const electronApp = yield* ElectronApp.ElectronApp;
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    const { launcherPath } = environment.localApp.value;
    return Layer.succeed(
      ElectronUpdater.ElectronUpdater,
      yield* make({
        // node and pnpm come from the login shell's PATH.
        nodeCommand: "node",
        scriptPath: environment.path.join(
          environment.rootDir,
          "apps/desktop/scripts/local-app.mjs",
        ),
        baseVersion: environment.appVersion.split("+")[0] ?? environment.appVersion,
        prepareEnvironment: shellEnvironment.installIntoProcess.pipe(Effect.asVoid),
        // Relaunch through the bundle's launcher so it picks up the new slot and commit.
        relaunch: electronApp
          .relaunch({ execPath: launcherPath, args: [] })
          .pipe(Effect.andThen(electronApp.quit)),
      }),
    );
  }),
);
