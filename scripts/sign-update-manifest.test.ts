// @effect-diagnostics nodeBuiltinImport:off - Signs a real release directory on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  UPDATE_MANIFEST_ASSET,
  UPDATE_SIGNATURE_ASSET,
  verifyUpdateFile,
  verifyUpdateManifest,
} from "../apps/desktop/src/updates/updateSignature.ts";
import { signReleaseDirectory } from "./sign-update-manifest.ts";

function makeKey() {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function releaseDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-sign-release-"));
  for (const name of [
    "BusyBoy-0.0.7-arm64.zip",
    "BusyBoy-0.0.7-arm64.dmg",
    "BusyBoy-Setup-0.0.7-x64.exe",
    "BusyBoy-Setup-0.0.7-x64.exe.blockmap",
    "latest.yml",
  ]) {
    NodeFS.writeFileSync(NodePath.join(dir, name), `contents of ${name}`);
  }
  return dir;
}

describe("signReleaseDirectory", () => {
  it("signs every installer and ZIP so the app's check accepts them", async () => {
    const key = makeKey();
    const dir = releaseDir();
    await signReleaseDirectory({
      version: "0.0.7",
      dir,
      privateKeyPem: key.privateKeyPem,
      publicKeys: [key.publicKeyPem],
    });

    const manifest = verifyUpdateManifest({
      manifest: NodeFS.readFileSync(NodePath.join(dir, UPDATE_MANIFEST_ASSET)),
      signature: NodeFS.readFileSync(NodePath.join(dir, UPDATE_SIGNATURE_ASSET), "utf8"),
      version: "0.0.7",
      publicKeys: [key.publicKeyPem],
    });
    assert.deepStrictEqual(
      manifest.files.map((file) => file.name),
      ["BusyBoy-0.0.7-arm64.dmg", "BusyBoy-0.0.7-arm64.zip", "BusyBoy-Setup-0.0.7-x64.exe"],
    );
    await verifyUpdateFile({
      manifest,
      path: NodePath.join(dir, "BusyBoy-Setup-0.0.7-x64.exe"),
    });
  });

  it("fails when the secret doesn't match the key the app ships", async () => {
    const dir = releaseDir();
    let error: unknown;
    try {
      await signReleaseDirectory({
        version: "0.0.7",
        dir,
        privateKeyPem: makeKey().privateKeyPem,
        publicKeys: [makeKey().publicKeyPem],
      });
    } catch (cause) {
      error = cause;
    }
    assert.match(String(error), /does not match any key in UPDATE_PUBLIC_KEYS/);
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, UPDATE_MANIFEST_ASSET)));
  });
});
