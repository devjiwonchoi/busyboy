// @effect-diagnostics nodeBuiltinImport:off - Writes real files and keys to check hashes and signatures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import * as UpdateSignature from "./updateSignature.ts";

function makeTestKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const key = makeTestKey();
const otherKey = makeTestKey();

const manifest: UpdateSignature.SignedUpdateManifest = {
  version: "0.0.7",
  files: [{ name: "BusyBoy-0.0.7-arm64.zip", sha512: "abc", size: 3 }],
};

const verify = (input: { manifest: Uint8Array; signature: string; version?: string }) =>
  UpdateSignature.verifyUpdateManifest({
    version: "0.0.7",
    publicKeys: [key.publicKeyPem],
    ...input,
  });

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (cause) {
    assert.isTrue(UpdateSignature.isUpdateVerificationError(cause), String(cause));
    assert.match((cause as Error).message, /could not be verified as coming from BusyBoy/);
    assert.match((cause as Error).message, pattern);
    return;
  }
  assert.fail("expected the update to be refused");
}

describe("verifyUpdateManifest", () => {
  it("accepts a manifest signed with a release key", () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, key.privateKeyPem);
    assert.deepStrictEqual(verify(signed), manifest);
  });

  it("refuses a manifest changed after signing", async () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, key.privateKeyPem);
    const tampered = Buffer.from(signed.manifest.toString().replace('"abc"', '"evil"'));
    await rejects(
      Promise.resolve().then(() => verify({ ...signed, manifest: tampered })),
      /does not match/,
    );
  });

  it("refuses a manifest signed with another key", async () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, otherKey.privateKeyPem);
    await rejects(
      Promise.resolve().then(() => verify(signed)),
      /does not match/,
    );
  });

  it("refuses a missing or malformed signature", async () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, key.privateKeyPem);
    await rejects(
      Promise.resolve().then(() => verify({ ...signed, signature: "" })),
      /missing or malformed/,
    );
    await rejects(
      Promise.resolve().then(() => verify({ ...signed, signature: "not base64!" })),
      /missing or malformed/,
    );
  });

  it("refuses a validly signed manifest for another version", async () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, key.privateKeyPem);
    await rejects(
      Promise.resolve().then(() => verify({ ...signed, version: "0.0.8" })),
      /for version 0.0.7, not 0.0.8/,
    );
  });

  it("ships a valid Ed25519 public key", () => {
    assert.isAbove(UpdateSignature.UPDATE_PUBLIC_KEYS.length, 0);
    for (const pem of UpdateSignature.UPDATE_PUBLIC_KEYS) {
      assert.strictEqual(NodeCrypto.createPublicKey(pem).asymmetricKeyType, "ed25519");
    }
  });
});

describe("verifyUpdateFile", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-update-sig-test-"));
  const path = NodePath.join(dir, "download");
  NodeFS.writeFileSync(path, "the real update");

  it("accepts a file whose hash and size are in the manifest", async () => {
    const actual = await UpdateSignature.hashFile(path);
    const signed = { version: "0.0.7", files: [{ name: "BusyBoy-0.0.7-arm64.zip", ...actual }] };
    assert.strictEqual(
      (
        await UpdateSignature.verifyUpdateFile({
          manifest: signed,
          path,
          name: "BusyBoy-0.0.7-arm64.zip",
        })
      ).name,
      "BusyBoy-0.0.7-arm64.zip",
    );
    // Windows doesn't know the asset name, only the hash.
    assert.strictEqual(
      (await UpdateSignature.verifyUpdateFile({ manifest: signed, path })).name,
      "BusyBoy-0.0.7-arm64.zip",
    );
  });

  it("refuses a file that differs from the manifest", async () => {
    await rejects(UpdateSignature.verifyUpdateFile({ manifest, path }), /does not match/);
  });

  it("refuses a file the manifest doesn't list", async () => {
    await rejects(
      UpdateSignature.verifyUpdateFile({ manifest, path, name: "BusyBoy-0.0.7-x64.zip" }),
      /not listed/,
    );
  });
});

describe("fetchVerifiedManifest", () => {
  const fetchFrom = (assets: Record<string, string>): typeof globalThis.fetch =>
    (async (url: string) => {
      const name = url.split("/").at(-1)!;
      assert.include(url, "https://github.com/devjiwonchoi/busyboy/releases/download/v0.0.7/");
      const body = assets[name];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    }) as typeof globalThis.fetch;

  const fetchManifest = (assets: Record<string, string>) =>
    UpdateSignature.fetchVerifiedManifest({
      owner: "devjiwonchoi",
      repo: "busyboy",
      version: "0.0.7",
      fetch: fetchFrom(assets),
      userAgent: "BusyBoy/0.0.6",
      publicKeys: [key.publicKeyPem],
    });

  it("downloads and verifies the release's signed manifest", async () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, key.privateKeyPem);
    assert.deepStrictEqual(
      await fetchManifest({
        [UpdateSignature.UPDATE_MANIFEST_ASSET]: signed.manifest.toString(),
        [UpdateSignature.UPDATE_SIGNATURE_ASSET]: signed.signature,
      }),
      manifest,
    );
  });

  it("refuses a release without a signature", async () => {
    const signed = UpdateSignature.signUpdateManifest(manifest, key.privateKeyPem);
    await rejects(
      fetchManifest({ [UpdateSignature.UPDATE_MANIFEST_ASSET]: signed.manifest.toString() }),
      /no busyboy-update.json.sig/,
    );
    await rejects(fetchManifest({}), /no busyboy-update.json/);
  });
});
