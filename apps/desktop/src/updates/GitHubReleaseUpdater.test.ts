// @effect-diagnostics nodeBuiltinImport:off - Builds real app bundles and archives on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import * as GitHubReleaseUpdater from "./GitHubReleaseUpdater.ts";

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

describe.runIf(isMac)("updating from a GitHub release", () => {
  it.effect("checks, downloads, and stages the new app bundle", () =>
    Effect.gen(function* () {
      const root = tempDir();
      const bundle = NodePath.join(root, "build/BusyBoy.app");
      makeBundle(bundle, "0.0.4");
      const zipPath = NodePath.join(root, "BusyBoy-0.0.4-arm64.zip");
      NodeChildProcess.execFileSync("ditto", ["-c", "-k", "--keepParent", bundle, zipPath]);
      const zip = NodeFS.readFileSync(zipPath);

      const fetch = (async (url: string) =>
        url.endsWith("/releases/latest")
          ? Response.json(release("v0.0.4", ["BusyBoy-0.0.4-arm64.zip"]))
          : new Response(zip, {
              headers: { "content-length": String(zip.byteLength) },
            })) as typeof globalThis.fetch;

      const updater = yield* GitHubReleaseUpdater.make({
        owner: "devjiwonchoi",
        repo: "busyboy",
        productName: "BusyBoy",
        currentVersion: "0.0.3",
        arch: "arm64",
        stagingDir: NodePath.join(root, "pending-update"),
        quit: Effect.void,
        fetch,
      });

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
});
