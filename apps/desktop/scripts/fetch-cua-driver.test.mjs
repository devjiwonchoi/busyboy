import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "vite-plus/test";

import {
  CUA_DRIVER_ASSETS,
  CUA_DRIVER_VERSION,
  cuaDriverAssetUrl,
  fetchCuaDriver,
  installFromArchive,
  isInstalled,
} from "./fetch-cua-driver.mjs";

describe("fetch-cua-driver", () => {
  let tmp;
  let outputDir;
  let archivePath;
  let asset;

  // A release-shaped archive with the three files the installer copies out.
  function makeArchive(name, files) {
    const root = NodePath.join(tmp, "archive-src");
    NodeFS.mkdirSync(NodePath.join(root, name), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      NodeFS.writeFileSync(NodePath.join(root, name, file), content);
    }
    const path = NodePath.join(tmp, `${name}.tar.gz`);
    NodeChildProcess.execFileSync("tar", ["-czf", path, "-C", root, name]);
    NodeFS.rmSync(root, { recursive: true, force: true });
    return path;
  }

  const sha256 = (file) =>
    NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

  beforeEach(() => {
    tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fetch-cua-driver-"));
    outputDir = NodePath.join(tmp, "resources", "cua-driver");
    const name = CUA_DRIVER_ASSETS.arm64.name;
    archivePath = makeArchive(name, {
      "cua-driver": "#!/bin/sh\n",
      LICENSE: "MIT",
      "THIRD_PARTY_NOTICES.md": "notices",
      "libcua_driver_sdk.dylib": "not copied",
    });
    asset = { name, sha256: sha256(archivePath) };
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("pins the release URL to the driver version", () => {
    assert.strictEqual(
      cuaDriverAssetUrl(CUA_DRIVER_ASSETS.x64),
      `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-x86_64.tar.gz`,
    );
  });

  it("installs only the executable and license files", () => {
    installFromArchive({ archivePath, asset, outputDir });

    assert.deepStrictEqual(NodeFS.readdirSync(outputDir).toSorted(), [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "VERSION",
      "cua-driver",
    ]);
    assert.strictEqual(NodeFS.statSync(NodePath.join(outputDir, "cua-driver")).mode & 0o777, 0o755);
    assert.isTrue(isInstalled(outputDir, asset));
  });

  it("rejects an archive whose hash differs from the pin and keeps the old install", () => {
    installFromArchive({ archivePath, asset, outputDir });

    assert.throws(
      () =>
        installFromArchive({ archivePath, asset: { ...asset, sha256: "0".repeat(64) }, outputDir }),
      /SHA-256/,
    );
    assert.isTrue(isInstalled(outputDir, asset));
  });

  it("treats a different pinned hash as not installed", () => {
    installFromArchive({ archivePath, asset, outputDir });

    assert.isFalse(isInstalled(outputDir, { ...asset, sha256: "f".repeat(64) }));
  });

  it("rejects an archive that is missing a required file", () => {
    const incomplete = makeArchive(asset.name, { "cua-driver": "#!/bin/sh\n" });

    assert.throws(
      () =>
        installFromArchive({
          archivePath: incomplete,
          asset: { ...asset, sha256: sha256(incomplete) },
          outputDir,
        }),
      /has no LICENSE/,
    );
    assert.isFalse(NodeFS.existsSync(outputDir));
  });

  it("skips the download when the pinned version is already installed", async () => {
    let downloads = 0;
    const fetchArchive = async (_url, destination) => {
      downloads += 1;
      NodeFS.copyFileSync(archivePath, destination);
    };
    const pinned = CUA_DRIVER_ASSETS.arm64;
    // The fake archive cannot match the real pin, so install the stamp directly.
    installFromArchive({ archivePath, asset, outputDir });
    NodeFS.writeFileSync(
      NodePath.join(outputDir, "VERSION"),
      `${CUA_DRIVER_VERSION} ${pinned.sha256}\n`,
    );

    assert.deepStrictEqual(await fetchCuaDriver({ arch: "arm64", outputDir, fetchArchive }), {
      status: "current",
    });
    assert.strictEqual(downloads, 0);
  });

  it("fails without touching the output when the download does not match the pin", async () => {
    const fetchArchive = async (_url, destination) => NodeFS.copyFileSync(archivePath, destination);

    let failure;
    try {
      await fetchCuaDriver({ arch: "arm64", outputDir, fetchArchive });
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), /SHA-256/);
    assert.isFalse(NodeFS.existsSync(outputDir));
  });
});
