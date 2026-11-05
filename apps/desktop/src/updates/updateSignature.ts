// @effect-diagnostics nodeBuiltinImport:off - Hashes downloaded installers and checks Ed25519 signatures with Node's crypto; also imported by the release script.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";

/**
 * Proof that an update came from us.
 *
 * The release job lists every installer and ZIP with its SHA-512 in
 * `busyboy-update.json` and signs that file with the Ed25519 key in the
 * `UPDATE_SIGNING_KEY` secret (scripts/sign-update-manifest.ts). The app
 * ships the public key below and refuses any update whose manifest, version,
 * or file hash does not check out.
 */

export const UPDATE_MANIFEST_ASSET = "busyboy-update.json";
export const UPDATE_SIGNATURE_ASSET = "busyboy-update.json.sig";

/**
 * Keys that may sign updates. To rotate, add the new key here, ship a release
 * signed with the old key, then switch the secret and drop the old key.
 */
export const UPDATE_PUBLIC_KEYS: ReadonlyArray<string> = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANJ4s4kF9EZwmC3l5wcpv0x5l26/Dxmw0ZAgtPH6k9no=
-----END PUBLIC KEY-----`,
];

export interface SignedUpdateFile {
  readonly name: string;
  /** Base64, like electron-builder's latest.yml. */
  readonly sha512: string;
  readonly size: number;
}

export interface SignedUpdateManifest {
  readonly version: string;
  readonly files: ReadonlyArray<SignedUpdateFile>;
}

const VERIFICATION_FAILED =
  "This update could not be verified as coming from BusyBoy, so it was not installed.";

/** Carries a message written for the user. */
export class UpdateVerificationError extends Error {
  constructor(reason: string) {
    super(`${VERIFICATION_FAILED} ${reason}`);
    this.name = "UpdateVerificationError";
  }
}

export const isUpdateVerificationError = (cause: unknown): cause is UpdateVerificationError =>
  cause instanceof UpdateVerificationError;

function parseManifest(bytes: Uint8Array): SignedUpdateManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UpdateVerificationError("Its update manifest is not valid JSON.");
  }
  const manifest = value as Partial<SignedUpdateManifest> | null;
  const files = manifest?.files;
  if (
    typeof manifest?.version !== "string" ||
    !Array.isArray(files) ||
    !files.every(
      (file: Partial<SignedUpdateFile> | null) =>
        typeof file?.name === "string" &&
        typeof file.sha512 === "string" &&
        typeof file.size === "number",
    )
  ) {
    throw new UpdateVerificationError("Its update manifest is malformed.");
  }
  return { version: manifest.version, files };
}

/**
 * Checks the manifest's signature against the built-in keys and that it is for
 * `version`. Returns the manifest only when both hold.
 */
export function verifyUpdateManifest(input: {
  readonly manifest: Uint8Array;
  readonly signature: string;
  readonly version: string;
  readonly publicKeys?: ReadonlyArray<string>;
}): SignedUpdateManifest {
  const signature = Buffer.from(input.signature.trim(), "base64");
  if (signature.byteLength !== 64) {
    throw new UpdateVerificationError("Its signature is missing or malformed.");
  }
  const signed = (input.publicKeys ?? UPDATE_PUBLIC_KEYS).some((key) => {
    try {
      return NodeCrypto.verify(null, input.manifest, key, signature);
    } catch {
      return false;
    }
  });
  if (!signed) {
    throw new UpdateVerificationError("Its signature does not match BusyBoy's release key.");
  }
  const manifest = parseManifest(input.manifest);
  if (manifest.version !== input.version) {
    throw new UpdateVerificationError(
      `Its signed manifest is for version ${manifest.version}, not ${input.version}.`,
    );
  }
  return manifest;
}

export async function hashFile(path: string): Promise<{ sha512: string; size: number }> {
  const hash = NodeCrypto.createHash("sha512");
  let size = 0;
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(path), async (source) => {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      hash.update(chunk);
    }
  });
  return { sha512: hash.digest("base64"), size };
}

/**
 * Checks a downloaded file against the signed manifest. With `name`, the file
 * must match that entry; without it, any entry with the same hash and size.
 */
export async function verifyUpdateFile(input: {
  readonly manifest: SignedUpdateManifest;
  readonly path: string;
  readonly name?: string;
}): Promise<SignedUpdateFile> {
  const actual = await hashFile(input.path);
  const candidates =
    input.name === undefined
      ? input.manifest.files
      : input.manifest.files.filter((file) => file.name === input.name);
  if (input.name !== undefined && candidates.length === 0) {
    throw new UpdateVerificationError(`${input.name} is not listed in its signed manifest.`);
  }
  const match = candidates.find(
    (file) => file.sha512 === actual.sha512 && file.size === actual.size,
  );
  if (match === undefined) {
    throw new UpdateVerificationError("The downloaded file does not match its signed manifest.");
  }
  return match;
}

/**
 * Downloads and verifies the signed manifest of the `v<version>` release. A
 * release without one is refused, so an unsigned release is never installed.
 */
export async function fetchVerifiedManifest(input: {
  readonly owner: string;
  readonly repo: string;
  readonly version: string;
  readonly fetch: typeof globalThis.fetch;
  readonly userAgent: string;
  readonly publicKeys?: ReadonlyArray<string>;
}): Promise<SignedUpdateManifest> {
  const base = `https://github.com/${input.owner}/${input.repo}/releases/download/v${input.version}`;
  const download = async (asset: string): Promise<Uint8Array> => {
    let response: Response;
    try {
      response = await input.fetch(`${base}/${asset}`, {
        headers: { "User-Agent": input.userAgent },
      });
    } catch (cause) {
      throw new Error(`Downloading ${asset} failed.`, { cause });
    }
    if (response.status === 404) {
      throw new UpdateVerificationError(`The release has no ${asset}.`);
    }
    if (!response.ok) {
      throw new Error(`Downloading ${asset} failed with ${response.status}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  const [manifest, signature] = await Promise.all([
    download(UPDATE_MANIFEST_ASSET),
    download(UPDATE_SIGNATURE_ASSET),
  ]);
  return verifyUpdateManifest({
    manifest,
    signature: new TextDecoder().decode(signature),
    version: input.version,
    ...(input.publicKeys ? { publicKeys: input.publicKeys } : {}),
  });
}

/** The release job's side: the manifest bytes and their base64 signature. */
export function signUpdateManifest(
  manifest: SignedUpdateManifest,
  privateKeyPem: string,
): { manifest: Buffer; signature: string } {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = NodeCrypto.sign(null, bytes, privateKeyPem).toString("base64");
  return { manifest: bytes, signature: `${signature}\n` };
}

/** The PEM public key for a private key, to check the secret against UPDATE_PUBLIC_KEYS. */
export function publicKeyFor(privateKeyPem: string): string {
  return NodeCrypto.createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString()
    .trim();
}
