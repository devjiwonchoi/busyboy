// @effect-diagnostics nodeBuiltinImport:off - A real AES cipher stands in for safeStorage in tests.
import * as NodeCrypto from "node:crypto";

import type { SecretCipher } from "./PasswordDatabase.ts";

/** AES-256-GCM with a random key, so ciphertext never contains the plaintext. */
export function makeTestCipher(): SecretCipher & { readonly calls: { decrypt: number } } {
  const key = NodeCrypto.randomBytes(32);
  const calls = { decrypt: 0 };
  return {
    calls,
    encrypt: (plaintext) => {
      const iv = NodeCrypto.randomBytes(12);
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    decrypt: (ciphertext) => {
      calls.decrypt += 1;
      const buffer = Buffer.from(ciphertext);
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

/** Every file of a SQLite database, including WAL and shared-memory files. */
export function readDatabaseBytes(read: (path: string) => Buffer | null, filename: string): Buffer {
  return Buffer.concat(
    [filename, `${filename}-wal`, `${filename}-shm`].flatMap((path) => {
      const bytes = read(path);
      return bytes === null ? [] : [bytes];
    }),
  );
}

export function containsSecret(bytes: Buffer, secret: string): boolean {
  return (
    bytes.includes(Buffer.from(secret, "utf8")) || bytes.includes(Buffer.from(secret, "utf16le"))
  );
}
