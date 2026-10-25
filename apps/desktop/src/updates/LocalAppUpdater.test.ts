import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import * as LocalAppUpdater from "./LocalAppUpdater.ts";

const OLD = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const UPDATER_EVENTS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
];

// An updater driving a stand-in for local-app.mjs whose behavior is `body`,
// plus the events it emitted.
const makeUpdater = Effect.fn(function* (
  body: string,
  relaunch: Effect.Effect<void> = Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const scriptPath = path.join(dir, "local-app.mjs");
  yield* fs.writeFileString(scriptPath, `const command = process.argv[2];\n${body}\n`);

  const updater = yield* LocalAppUpdater.make({
    nodeCommand: process.execPath,
    scriptPath,
    baseVersion: "0.1.0",
    prepareEnvironment: Effect.void,
    relaunch,
  });
  const events: Array<[string, unknown]> = [];
  yield* Effect.forEach(UPDATER_EVENTS, (name) =>
    updater.on(name, (payload: unknown) => {
      events.push([name, payload]);
    }),
  );
  return { updater, events };
});

describe("LocalAppUpdater", () => {
  it.effect("reports new commits on origin/main as an available update", () =>
    Effect.gen(function* () {
      const { updater, events } = yield* makeUpdater(
        `console.log(JSON.stringify({ currentCommit: "${OLD}", latestCommit: "${NEW}", commits: ["first", "second"] }));`,
      );

      yield* updater.checkForUpdates;

      assert.deepEqual(events, [
        ["checking-for-update", undefined],
        ["update-available", { version: "0.1.0+2222222", releaseNotes: "- first\n- second" }],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no update when the current slot is at origin/main", () =>
    Effect.gen(function* () {
      const { updater, events } = yield* makeUpdater(
        `console.log(JSON.stringify({ currentCommit: "${NEW}", latestCommit: "${NEW}", commits: [] }));`,
      );

      yield* updater.checkForUpdates;

      assert.deepEqual(
        events.map(([name]) => name),
        ["checking-for-update", "update-not-available"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("turns build progress into download progress and a downloaded version", () =>
    Effect.gen(function* () {
      const { updater, events } = yield* makeUpdater(
        [
          `for (const [phase, percent] of [["fetch", 5], ["build", 50]]) console.log(JSON.stringify({ phase, percent }));`,
          `console.log(JSON.stringify({ phase: "done", percent: 100, commit: "${NEW}" }));`,
        ].join("\n"),
      );

      yield* updater.downloadUpdate;

      assert.deepEqual(events, [
        ["download-progress", { percent: 5 }],
        ["download-progress", { percent: 50 }],
        ["download-progress", { percent: 100 }],
        ["update-downloaded", { version: "0.1.0+2222222" }],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces the script's failure reason when the build fails", () =>
    Effect.gen(function* () {
      const { updater } = yield* makeUpdater(
        `console.error("pnpm build failed (exit 1). See /root/update.log"); process.exit(1);`,
      );

      const error = yield* Effect.flip(updater.downloadUpdate);

      assert.equal(error._tag, "ElectronUpdaterDownloadUpdateError");
      assert.isTrue(LocalAppUpdater.isLocalAppUpdateError(error.cause));
      assert.equal(
        (error.cause as LocalAppUpdater.LocalAppUpdateError).message,
        "pnpm build failed (exit 1). See /root/update.log",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("switches slots before relaunching, and not at all if the switch fails", () =>
    Effect.gen(function* () {
      let relaunches = 0;
      const relaunch = Effect.sync(() => {
        relaunches += 1;
      });

      const switched = yield* makeUpdater(`if (command !== "switch") process.exit(2);`, relaunch);
      yield* switched.updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      assert.equal(relaunches, 1);

      const failing = yield* makeUpdater(
        `console.error("No prepared update. Run prepare first."); process.exit(1);`,
        relaunch,
      );
      const error = yield* Effect.flip(
        failing.updater.quitAndInstall({ isSilent: true, isForceRunAfter: true }),
      );

      assert.equal(error._tag, "ElectronUpdaterQuitAndInstallError");
      assert.equal(relaunches, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
