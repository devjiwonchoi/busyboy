// @effect-diagnostics nodeBuiltinImport:off - Uses a real downloaded file on disk.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import { UpdateVerificationError } from "../updates/updateSignature.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

// Stands in for electron-updater: checks offer 0.0.7, downloads write an installer.
function fakeUpdater(installer: string) {
  const events = new NodeEvents.EventEmitter();
  const quitAndInstall = vi.fn();
  const addQuitHandler = vi.fn();
  const installOnQuitDuringDownload: Array<boolean> = [];
  const updater = {
    autoInstallOnAppQuit: true,
    addQuitHandler,
    on: (event: string, listener: (...args: Array<unknown>) => void) => events.on(event, listener),
    removeListener: (event: string, listener: (...args: Array<unknown>) => void) =>
      events.removeListener(event, listener),
    checkForUpdates: async () => ({ updateInfo: { version: "0.0.7" } }),
    downloadUpdate: async () => {
      installOnQuitDuringDownload.push(updater.autoInstallOnAppQuit);
      NodeFS.writeFileSync(installer, "installer");
      events.emit("update-downloaded", { version: "0.0.7" });
      return [installer];
    },
    quitAndInstall,
  };
  return { updater, quitAndInstall, addQuitHandler, installOnQuitDuringDownload };
}

function setup(verify: ElectronUpdater.VerifyDownload) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-verified-updater-"));
  const installer = NodePath.join(dir, "BusyBoy-Setup-0.0.7-x64.exe");
  const fake = fakeUpdater(installer);
  const seen: Array<unknown> = [];
  const service = ElectronUpdater.makeVerified(verify, fake.updater as never);
  return { service, installer, seen, ...fake };
}

const install = { isSilent: false, isForceRunAfter: true };

describe("ElectronUpdater.makeVerified", () => {
  it.effect("announces and installs a download only after it is verified", () =>
    Effect.gen(function* () {
      const verify = vi.fn(async () => {});
      const { service, installer, seen, quitAndInstall } = setup(verify);
      yield* service.on("update-downloaded", (info: unknown) => seen.push(info));

      yield* service.checkForUpdates;
      yield* service.downloadUpdate;
      assert.deepStrictEqual(verify.mock.calls, [[{ version: "0.0.7", files: [installer] }]]);
      assert.deepStrictEqual(seen, [{ version: "0.0.7" }]);

      yield* service.quitAndInstall(install);
      assert.strictEqual(quitAndInstall.mock.calls.length, 1);
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  it.effect("refuses, deletes, and never installs a download that fails verification", () =>
    Effect.gen(function* () {
      const { service, installer, seen, quitAndInstall } = setup(async () => {
        throw new UpdateVerificationError("Its signature does not match BusyBoy's release key.");
      });
      yield* service.on("update-downloaded", (info: unknown) => seen.push(info));

      yield* service.checkForUpdates;
      const download = yield* Effect.exit(service.downloadUpdate);
      assert.isTrue(Exit.isFailure(download));
      const failure = Exit.isFailure(download) ? download.cause.toString() : "";
      assert.include(failure, "could not be verified as coming from BusyBoy");
      assert.isFalse(NodeFS.existsSync(installer));
      assert.deepStrictEqual(seen, []);

      const installed = yield* Effect.exit(service.quitAndInstall(install));
      assert.isTrue(Exit.isFailure(installed));
      assert.strictEqual(quitAndInstall.mock.calls.length, 0);
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  it.effect("refuses to install before anything was downloaded and verified", () =>
    Effect.gen(function* () {
      const { service, quitAndInstall } = setup(async () => {});
      const installed = yield* Effect.exit(service.quitAndInstall(install));
      assert.isTrue(Exit.isFailure(installed));
      assert.strictEqual(quitAndInstall.mock.calls.length, 0);
    }),
  );

  it.effect("turns install-on-quit on only once a download is verified", () =>
    Effect.gen(function* () {
      const installOnQuitDuringVerify: Array<boolean> = [];
      const { service, updater, addQuitHandler, installOnQuitDuringDownload } = setup(async () => {
        installOnQuitDuringVerify.push(updater.autoInstallOnAppQuit);
      });
      // electron-updater defaults the flag to on; the wrapper keeps it off until verified.
      assert.isFalse(updater.autoInstallOnAppQuit);
      yield* service.setAutoInstallOnAppQuit(true);
      assert.isFalse(updater.autoInstallOnAppQuit);

      yield* service.checkForUpdates;
      yield* service.downloadUpdate;
      assert.deepStrictEqual(installOnQuitDuringDownload, [false]);
      assert.deepStrictEqual(installOnQuitDuringVerify, [false]);
      assert.isTrue(updater.autoInstallOnAppQuit);
      assert.strictEqual(addQuitHandler.mock.calls.length, 1);

      // A new download turns it off again until that one is verified too.
      yield* service.downloadUpdate;
      assert.deepStrictEqual(installOnQuitDuringDownload, [false, false]);
      assert.isTrue(updater.autoInstallOnAppQuit);
    }),
  );

  it.effect("never installs on quit a download that fails verification", () =>
    Effect.gen(function* () {
      const { service, updater, addQuitHandler } = setup(async () => {
        throw new UpdateVerificationError("Its signature does not match BusyBoy's release key.");
      });
      yield* service.setAutoInstallOnAppQuit(true);
      yield* service.checkForUpdates;
      yield* Effect.exit(service.downloadUpdate);
      assert.isFalse(updater.autoInstallOnAppQuit);
      assert.strictEqual(addQuitHandler.mock.calls.length, 0);
    }),
  );
});
