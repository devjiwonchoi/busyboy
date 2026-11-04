// @effect-diagnostics nodeBuiltinImport:off - Reads a copied Login Data file with node:sqlite.
import { DatabaseSync } from "node:sqlite";

import { decryptChromiumValue } from "./ChromiumCookies.ts";
import type { ChromiumKeyMaterial } from "./ChromiumKeys.ts";

/** Microseconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;

/** One row of Chromium's `logins` table, as stored (password still encrypted). */
export interface ChromiumLoginRow {
  readonly originUrl: string;
  readonly signonRealm: string;
  readonly username: string;
  readonly encryptedPassword: Uint8Array;
  /** Microseconds since 1601; larger than a safe JavaScript number, so kept as bigint. */
  readonly dateCreated: bigint;
  readonly dateLastUsed: bigint;
  readonly blacklisted: boolean;
}

/** A decrypted login ready for the vault. Lives only in main memory, briefly. */
export interface ImportableLogin {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface ChromiumPasswordPlan {
  readonly logins: ReadonlyArray<ImportableLogin>;
  readonly neverSave: ReadonlyArray<string>;
  /** Rows whose password could not be decrypted. */
  readonly failed: number;
}

/** Chromium timestamps are microseconds since 1601-01-01; 0 means unset. */
export function chromiumTimeToEpochMs(micros: bigint): number | null {
  if (micros <= 0n) return null;
  return Number((micros - WINDOWS_EPOCH_OFFSET_MICROS) / 1_000n);
}

/**
 * Web-form logins are keyed by `https://host[:port]/`. HTTP-auth realms
 * (`origin realm-name`), Android and other app realms are not supported.
 */
export function realmToOrigin(signonRealm: string): string | null {
  if (/\s/.test(signonRealm.trim())) return null;
  try {
    const url = new URL(signonRealm);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

/**
 * Decrypts a `password_value`. Newer Chromium may bind a value to its site by
 * prefixing the plaintext with a SHA-256 hash; both forms are accepted.
 */
export function decryptChromiumPassword(
  row: Pick<ChromiumLoginRow, "encryptedPassword" | "originUrl" | "signonRealm">,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
): string | null {
  const host = hostOf(row.signonRealm) ?? hostOf(row.originUrl);
  const bindings = [...(host === null ? [] : [host, `.${host}`]), row.signonRealm, row.originUrl];
  for (const binding of bindings) {
    const bound = decryptChromiumValue(row.encryptedPassword, keys, binding, 24, platform);
    if (bound !== null) return bound;
  }
  return decryptChromiumValue(row.encryptedPassword, keys, "", 23, platform);
}

/** Reads the `logins` table of a Login Data copy, opened read-only. */
export function readChromiumLoginRows(filename: string): ReadonlyArray<ChromiumLoginRow> {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const statement = db.prepare(
      `SELECT origin_url, signon_realm, username_value, password_value, date_created,
              date_last_used, blacklisted_by_user
       FROM logins`,
    );
    // Chromium's times exceed Number.MAX_SAFE_INTEGER.
    statement.setReadBigInts(true);
    const rows = statement.all() as unknown as Array<{
      origin_url: string | null;
      signon_realm: string | null;
      username_value: string | null;
      password_value: Uint8Array | null;
      date_created: number | bigint | null;
      date_last_used: number | bigint | null;
      blacklisted_by_user: number | bigint | null;
    }>;
    return rows.map((row) => ({
      originUrl: row.origin_url ?? "",
      signonRealm: row.signon_realm ?? "",
      username: row.username_value ?? "",
      encryptedPassword: row.password_value ?? new Uint8Array(),
      dateCreated: BigInt(row.date_created ?? 0),
      dateLastUsed: BigInt(row.date_last_used ?? 0),
      blacklisted: Number(row.blacklisted_by_user ?? 0) === 1,
    }));
  } finally {
    db.close();
  }
}

/**
 * Decrypts the rows worth importing. Within Chromium's own data, the newest
 * row wins for each (site, username). Rows without a password are skipped.
 */
export function planChromiumPasswordImport(
  rows: ReadonlyArray<ChromiumLoginRow>,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
): ChromiumPasswordPlan {
  const neverSave = new Set<string>();
  const byKey = new Map<string, ImportableLogin>();
  let failed = 0;
  for (const row of rows) {
    const origin = realmToOrigin(row.signonRealm);
    if (origin === null) continue;
    if (row.blacklisted) {
      neverSave.add(origin);
      continue;
    }
    if (row.encryptedPassword.length === 0) continue;
    const password = decryptChromiumPassword(row, keys, platform);
    if (password === null) {
      failed += 1;
      continue;
    }
    if (password.length === 0) continue;
    const createdAt = chromiumTimeToEpochMs(row.dateCreated) ?? 0;
    const lastUsedAt = chromiumTimeToEpochMs(row.dateLastUsed);
    const login: ImportableLogin = {
      origin,
      username: row.username,
      password,
      createdAt,
      lastUsedAt,
    };
    const key = JSON.stringify([origin, row.username]);
    const existing = byKey.get(key);
    if (existing === undefined || recency(login) > recency(existing)) byKey.set(key, login);
  }
  return { logins: [...byKey.values()], neverSave: [...neverSave], failed };
}

export const recency = (login: {
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}) => Math.max(login.createdAt, login.lastUsedAt ?? 0);
