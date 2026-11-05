#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain release script run by the publish job.
// Writes busyboy-update.json (every installer and ZIP with its SHA-512) and its Ed25519
// signature into the release directory. Installed apps refuse an update that it doesn't cover.
//
//   UPDATE_SIGNING_KEY=<pem> node scripts/sign-update-manifest.ts <version> <release-dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  hashFile,
  publicKeyFor,
  signUpdateManifest,
  UPDATE_MANIFEST_ASSET,
  UPDATE_PUBLIC_KEYS,
  UPDATE_SIGNATURE_ASSET,
  verifyUpdateFile,
  verifyUpdateManifest,
  type SignedUpdateManifest,
} from "../apps/desktop/src/updates/updateSignature.ts";

// What an installed app downloads to update or a person downloads to install.
const SIGNED_EXTENSIONS = [".zip", ".dmg", ".exe"];

export async function signReleaseDirectory(input: {
  readonly version: string;
  readonly dir: string;
  readonly privateKeyPem: string;
  readonly publicKeys?: ReadonlyArray<string>;
}): Promise<SignedUpdateManifest> {
  const publicKeys = input.publicKeys ?? UPDATE_PUBLIC_KEYS;
  const publicKey = publicKeyFor(input.privateKeyPem);
  if (!publicKeys.some((key) => key.trim() === publicKey)) {
    throw new Error(
      "UPDATE_SIGNING_KEY does not match any key in UPDATE_PUBLIC_KEYS (apps/desktop/src/updates/updateSignature.ts).",
    );
  }
  const names = NodeFS.readdirSync(input.dir)
    .filter((name) => SIGNED_EXTENSIONS.includes(NodePath.extname(name).toLowerCase()))
    .sort();
  if (names.length === 0) throw new Error(`No installers or ZIPs in ${input.dir}.`);

  const files = [];
  for (const name of names) {
    files.push({ name, ...(await hashFile(NodePath.join(input.dir, name))) });
  }
  const manifest: SignedUpdateManifest = { version: input.version, files };
  const signed = signUpdateManifest(manifest, input.privateKeyPem);

  // Check the output the way the app will before anything is published.
  const verified = verifyUpdateManifest({
    manifest: signed.manifest,
    signature: signed.signature,
    version: input.version,
    publicKeys,
  });
  for (const name of names) {
    await verifyUpdateFile({ manifest: verified, path: NodePath.join(input.dir, name), name });
  }

  NodeFS.writeFileSync(NodePath.join(input.dir, UPDATE_MANIFEST_ASSET), signed.manifest);
  NodeFS.writeFileSync(NodePath.join(input.dir, UPDATE_SIGNATURE_ASSET), signed.signature);
  return manifest;
}

if (import.meta.main) {
  const [version, dir] = process.argv.slice(2);
  const privateKeyPem = process.env.UPDATE_SIGNING_KEY;
  if (!version || !dir) {
    console.error("usage: sign-update-manifest.ts <version> <release-dir>");
    process.exit(1);
  }
  if (!privateKeyPem) {
    console.error("::error::Missing secret UPDATE_SIGNING_KEY in the release environment.");
    process.exit(1);
  }
  const manifest = await signReleaseDirectory({ version, dir, privateKeyPem });
  console.log(`Signed ${UPDATE_MANIFEST_ASSET} for v${version}:`);
  for (const file of manifest.files) console.log(`  ${file.name}  ${file.size} bytes`);
}
