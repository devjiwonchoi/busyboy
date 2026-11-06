// @effect-diagnostics nodeBuiltinImport:off - Builds real app bundles and archives on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import * as GitHubReleaseUpdater from "./GitHubReleaseUpdater.ts";
import * as UpdateSignature from "./updateSignature.ts";

const isMac = process.platform === "darwin";

function tempDir(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-updater-test-"));
}

function makeBundle(path: string, marker: string): void {
  NodeFS.mkdirSync(NodePath.join(path, "Contents/MacOS"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(path, "Contents/marker"), marker);
}

const release = (tag: string, assets: Array<string>): GitHubReleaseUpdater.GitHubRelease => ({
  tag_name: tag,
  body: `Notes for ${tag}`,
  assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })),
});

describe("resolveAvailableUpdate", () => {
  const resolve = (tag: string, assets: Array<string>, currentVersion = "0.0.3") =>
    GitHubReleaseUpdater.resolveAvailableUpdate({
      release: release(tag, assets),
      currentVersion,
      productName: "BusyBoy",
      arch: "arm64",
    });

  it("offers a newer release that ships this architecture's zip", () => {
    assert.deepStrictEqual(resolve("v0.0.10", ["BusyBoy-0.0.10-arm64.zip"]), {
      version: "0.0.10",
      releaseNotes: "Notes for v0.0.10",
      zipName: "BusyBoy-0.0.10-arm64.zip",
      zipUrl: "https://example.test/BusyBoy-0.0.10-arm64.zip",
    });
  });

  it("matches the zip regardless of the product name's casing", () => {
    assert.strictEqual(
      resolve("v0.0.4", ["busyboy-0.0.4-arm64.zip"])?.zipUrl,
      "https://example.test/busyboy-0.0.4-arm64.zip",
    );
  });

  it("ignores the running version, older ones, and releases without the zip", () => {
    assert.strictEqual(resolve("v0.0.3", ["BusyBoy-0.0.3-arm64.zip"]), null);
    assert.strictEqual(resolve("v0.0.2", ["BusyBoy-0.0.2-arm64.zip"]), null);
    assert.strictEqual(resolve("v0.0.4", ["BusyBoy-0.0.4-x64.zip"]), null);
  });

  it("treats a local-app build's commit suffix as its base version", () => {
    assert.strictEqual(resolve("v0.0.3", ["BusyBoy-0.0.3-arm64.zip"], "0.0.3+abc1234"), null);
  });
});

describe("parseGitHubFeed", () => {
  it("reads the repository electron-builder writes", () => {
    assert.deepStrictEqual(
      GitHubReleaseUpdater.parseGitHubFeed(
        "owner: devjiwonchoi\nrepo: busyboy\nprovider: github\nreleaseType: release\n",
      ),
      { owner: "devjiwonchoi", repo: "busyboy" },
    );
    assert.strictEqual(GitHubReleaseUpdater.parseGitHubFeed("provider: generic\nurl: x\n"), null);
  });
});

const releaseKey = (() => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
})();

/** A v0.0.4 release whose ZIP holds a fake app, optionally signed or tampered with. */
function makeRelease(options: { readonly signed: boolean; readonly tamper?: boolean }) {
  const root = tempDir();
  const bundle = NodePath.join(root, "build/BusyBoy.app");
  makeBundle(bundle, "0.0.4");
  const zipPath = NodePath.join(root, "BusyBoy-0.0.4-arm64.zip");
  NodeChildProcess.execFileSync("ditto", ["-c", "-k", "--keepParent", bundle, zipPath]);
  const signed = UpdateSignature.signUpdateManifest(
    {
      version: "0.0.4",
      files: [
        {
          name: "BusyBoy-0.0.4-arm64.zip",
          sha512: NodeCrypto.createHash("sha512")
            .update(NodeFS.readFileSync(zipPath))
            .digest("base64"),
          size: NodeFS.statSync(zipPath).size,
        },
      ],
    },
    releaseKey.privateKeyPem,
  );
  // A swapped ZIP: still a valid archive, but not the one that was signed.
  if (options.tamper) {
    makeBundle(bundle, "evil");
    NodeFS.rmSync(zipPath);
    NodeChildProcess.execFileSync("ditto", ["-c", "-k", "--keepParent", bundle, zipPath]);
  }
  const zip = NodeFS.readFileSync(zipPath);
  const assets: Record<string, string> = options.signed
    ? {
        [UpdateSignature.UPDATE_MANIFEST_ASSET]: signed.manifest.toString(),
        [UpdateSignature.UPDATE_SIGNATURE_ASSET]: signed.signature,
      }
    : {};
  const fetch = (async (url: string) => {
    if (url.endsWith("/releases/latest")) {
      return Response.json(release("v0.0.4", ["BusyBoy-0.0.4-arm64.zip"]));
    }
    if (url.startsWith("https://github.com/devjiwonchoi/busyboy/releases/download/v0.0.4/")) {
      const body = assets[url.split("/").at(-1)!];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    }
    return new Response(zip, { headers: { "content-length": String(zip.byteLength) } });
  }) as typeof globalThis.fetch;
  return { root, fetch };
}

interface QuitHarness {
  quit: () => void;
  installs: Array<ReadonlyArray<string>>;
}

const makeQuitHarness = (): QuitHarness & {
  onQuit: (listener: () => void) => Effect.Effect<void>;
} => {
  const listeners: Array<() => void> = [];
  return {
    installs: [],
    quit: () => listeners.forEach((listener) => listener()),
    onQuit: (listener) => Effect.sync(() => void listeners.push(listener)),
  };
};

const makeUpdater = (
  root: string,
  fetch: typeof globalThis.fetch,
  codeSigned = true,
  quitHarness = makeQuitHarness(),
) =>
  GitHubReleaseUpdater.make({
    owner: "devjiwonchoi",
    repo: "busyboy",
    productName: "BusyBoy",
    currentVersion: "0.0.3",
    arch: "arm64",
    stagingDir: NodePath.join(root, "pending-update"),
    quit: Effect.void,
    onQuit: quitHarness.onQuit,
    appBundlePath: NodePath.join(root, "BusyBoy.app"),
    spawnInstaller: (args) => quitHarness.installs.push(args),
    fetch,
    publicKeys: [releaseKey.publicKeyPem],
    // The fake bundle has no Developer ID; the real check is tested on its own below.
    verifyCodeSignature: () => {
      if (!codeSigned) {
        throw new UpdateSignature.UpdateVerificationError(
          "The new app is not signed with BusyBoy's Apple Developer ID.",
        );
      }
    },
  });

describe.runIf(isMac)("updating from a GitHub release", () => {
  it.effect("checks, downloads, verifies, and stages the new app bundle", () =>
    Effect.gen(function* () {
      const { root, fetch } = makeRelease({ signed: true });
      const updater = yield* makeUpdater(root, fetch);

      const seen: Array<[string, unknown]> = [];
      for (const event of ["update-available", "download-progress", "update-downloaded"]) {
        yield* updater.on(event, (info: unknown) => seen.push([event, info]));
      }

      yield* updater.checkForUpdates;
      yield* updater.downloadUpdate;

      assert.deepStrictEqual(seen[0], [
        "update-available",
        { version: "0.0.4", releaseNotes: "Notes for v0.0.4" },
      ]);
      assert.deepStrictEqual(seen.at(-1), ["update-downloaded", { version: "0.0.4" }]);
      assert.deepStrictEqual(seen.at(-2), ["download-progress", { percent: 100 }]);
      const staged = NodePath.join(root, "pending-update/0.0.4/app/BusyBoy.app/Contents/marker");
      assert.strictEqual(NodeFS.readFileSync(staged, "utf8"), "0.0.4");
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  const refuses = (
    options: { signed: boolean; tamper?: boolean; codeSigned?: boolean },
    reason: RegExp,
  ) =>
    Effect.gen(function* () {
      const { root, fetch } = makeRelease(options);
      const updater = yield* makeUpdater(root, fetch, options.codeSigned ?? true);
      const downloaded: Array<unknown> = [];
      yield* updater.on("update-downloaded", (info: unknown) => downloaded.push(info));

      yield* updater.checkForUpdates;
      const download = yield* Effect.exit(updater.downloadUpdate);
      assert.isTrue(Exit.isFailure(download));
      const cause = Exit.isFailure(download) ? download.cause.toString() : "";
      assert.include(cause, "could not be verified as coming from BusyBoy");
      assert.match(cause, reason);
      assert.deepStrictEqual(downloaded, []);
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "pending-update")));

      const install = yield* Effect.exit(
        updater.quitAndInstall({ isSilent: false, isForceRunAfter: true }),
      );
      assert.isTrue(Exit.isFailure(install));
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe()));

  it.effect("refuses a release without a signed manifest", () =>
    refuses({ signed: false }, /no busyboy-update.json/),
  );

  it.effect("refuses a ZIP that differs from the signed manifest", () =>
    refuses({ signed: true, tamper: true }, /does not match its signed manifest/),
  );

  it.effect("refuses an app without BusyBoy's Developer ID", () =>
    refuses({ signed: true, codeSigned: false }, /Apple Developer ID/),
  );

  it.effect("installs the verified app when the user quits, without reopening it", () =>
    Effect.gen(function* () {
      const { root, fetch } = makeRelease({ signed: true });
      const harness = makeQuitHarness();
      const updater = yield* makeUpdater(root, fetch, true, harness);
      yield* updater.setAutoInstallOnAppQuit(true);

      // Nothing staged yet: quitting installs nothing.
      yield* updater.checkForUpdates;
      harness.quit();
      assert.deepStrictEqual(harness.installs, []);

      yield* updater.downloadUpdate;
      harness.quit();
      const staged = NodePath.join(root, "pending-update/0.0.4/app/BusyBoy.app");
      assert.deepStrictEqual(harness.installs, [
        [String(process.pid), NodePath.join(root, "BusyBoy.app"), staged, "no-reopen"],
      ]);
      harness.quit();
      assert.strictEqual(harness.installs.length, 1);
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  it.effect("restart installs and reopens once; the quit that follows adds nothing", () =>
    Effect.gen(function* () {
      const { root, fetch } = makeRelease({ signed: true });
      const harness = makeQuitHarness();
      const updater = yield* makeUpdater(root, fetch, true, harness);
      yield* updater.setAutoInstallOnAppQuit(true);
      yield* updater.checkForUpdates;
      yield* updater.downloadUpdate;

      yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      harness.quit();
      assert.deepStrictEqual(
        harness.installs.map((args) => args[3]),
        ["reopen"],
      );
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  it.effect("never installs on quit a download that failed verification", () =>
    Effect.gen(function* () {
      const { root, fetch } = makeRelease({ signed: true, tamper: true });
      const harness = makeQuitHarness();
      const updater = yield* makeUpdater(root, fetch, true, harness);
      yield* updater.setAutoInstallOnAppQuit(true);
      yield* updater.checkForUpdates;
      yield* Effect.exit(updater.downloadUpdate);
      harness.quit();
      assert.deepStrictEqual(harness.installs, []);
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  it.effect("leaves a verified app staged on quit when install-on-quit is off", () =>
    Effect.gen(function* () {
      const { root, fetch } = makeRelease({ signed: true });
      const harness = makeQuitHarness();
      const updater = yield* makeUpdater(root, fetch, true, harness);
      yield* updater.checkForUpdates;
      yield* updater.downloadUpdate;
      harness.quit();
      assert.deepStrictEqual(harness.installs, []);
    }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
  );

  it("requires BusyBoy's Developer ID on the unpacked app", () => {
    const root = tempDir();
    const bundle = NodePath.join(root, "BusyBoy.app");
    makeBundle(bundle, "unsigned");
    assert.throws(
      () => GitHubReleaseUpdater.verifyAppCodeSignature(bundle),
      /not signed with BusyBoy's Apple Developer ID/,
    );
  });

  // Only on a Mac with a release build installed: the shipped app passes the same check.
  it.runIf(NodeFS.existsSync("/Applications/BusyBoy.app"))(
    "accepts the installed release app",
    () => {
      GitHubReleaseUpdater.verifyAppCodeSignature("/Applications/BusyBoy.app");
    },
  );

  it("swaps the bundle once the app exits, then reopens it", () => {
    const root = tempDir();
    const target = NodePath.join(root, "Applications/BusyBoy.app");
    const staged = NodePath.join(root, "staged/BusyBoy.app");
    makeBundle(target, "old");
    makeBundle(staged, "new");

    // A fake `open` records what would be launched instead of launching it.
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    const opened = NodePath.join(root, "opened");
    NodeFS.writeFileSync(NodePath.join(bin, "open"), `#!/bin/sh\necho "$1" > "${opened}"\n`, {
      mode: 0o755,
    });

    // Stands in for the quitting app. Backgrounded so launchd reaps it; a
    // child of this test would linger as a zombie that still answers kill -0.
    const appPid = NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", "sleep 0.3 >/dev/null & echo $!"],
      {
        encoding: "utf8",
      },
    ).trim();
    NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", GitHubReleaseUpdater.INSTALL_SCRIPT, "test", appPid, target, staged],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );

    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(target, "Contents/marker"), "utf8"),
      "new",
    );
    assert.isFalse(NodeFS.existsSync(staged));
    assert.isFalse(NodeFS.existsSync(`${target}.previous`));
    assert.strictEqual(NodeFS.readFileSync(opened, "utf8").trim(), target);
  });

  it("swaps the bundle without reopening it when installing on quit", () => {
    const root = tempDir();
    const target = NodePath.join(root, "Applications/BusyBoy.app");
    const staged = NodePath.join(root, "staged/BusyBoy.app");
    makeBundle(target, "old");
    makeBundle(staged, "new");
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    const opened = NodePath.join(root, "opened");
    NodeFS.writeFileSync(NodePath.join(bin, "open"), `#!/bin/sh\necho "$1" > "${opened}"\n`, {
      mode: 0o755,
    });
    const appPid = NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", "sleep 0.3 >/dev/null & echo $!"],
      { encoding: "utf8" },
    ).trim();
    NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", GitHubReleaseUpdater.INSTALL_SCRIPT, "test", appPid, target, staged, "no-reopen"],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );

    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(target, "Contents/marker"), "utf8"),
      "new",
    );
    assert.isFalse(NodeFS.existsSync(opened));
  });
});
