// @effect-diagnostics nodeBuiltinImport:off - Builds a fixture Login Data file and vault on disk.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { importIntoVault } from "../BrowserPasswords/ImportIntoVault.ts";
import { PasswordDatabase } from "../BrowserPasswords/PasswordDatabase.ts";
import {
  containsSecret,
  makeTestCipher,
  readDatabaseBytes,
} from "../BrowserPasswords/testCipher.ts";
import {
  chromiumTimeToEpochMs,
  planChromiumPasswordImport,
  readChromiumLoginRows,
  realmToOrigin,
} from "./ChromiumPasswords.ts";

// Chromium's macOS v10 scheme with a known test passphrase.
const TEST_KEY = NodeCrypto.pbkdf2Sync("fixture-passphrase", "saltysalt", 1003, 16, "sha1");
const IV = Buffer.alloc(16, 0x20);

const v10 = (plaintext: Buffer | string) => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", TEST_KEY, IV);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), body]);
};
/** Newer Chromium prefixes the plaintext with SHA-256 of the host. */
const v10Bound = (host: string, plaintext: string) =>
  v10(
    Buffer.concat([NodeCrypto.createHash("sha256").update(host).digest(), Buffer.from(plaintext)]),
  );

/** Chromium time: microseconds since 1601-01-01. */
const chromiumTime = (epochMs: number) => (BigInt(epochMs) + 11_644_473_600_000n) * 1_000n;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(
  rows: ReadonlyArray<{
    origin_url: string;
    signon_realm: string;
    username_value: string;
    password_value: Buffer;
    date_created: bigint;
    date_last_used: bigint | 0;
    blacklisted_by_user?: number;
  }>,
) {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-login-data-"));
  cleanups.push(() => NodeFs.rmSync(directory, { recursive: true, force: true }));
  const filename = NodePath.join(directory, "Login Data");
  const db = new DatabaseSync(filename);
  // Chromium's logins columns that matter here, plus a few it also has.
  db.exec(`CREATE TABLE logins (
    origin_url VARCHAR NOT NULL, action_url VARCHAR, username_element VARCHAR,
    username_value VARCHAR, password_element VARCHAR, password_value BLOB,
    submit_element VARCHAR, signon_realm VARCHAR NOT NULL, date_created INTEGER NOT NULL,
    blacklisted_by_user INTEGER NOT NULL, scheme INTEGER NOT NULL, times_used INTEGER,
    date_last_used INTEGER NOT NULL DEFAULT 0, id INTEGER PRIMARY KEY AUTOINCREMENT
  )`);
  const insert = db.prepare(
    `INSERT INTO logins (origin_url, username_value, password_value, signon_realm, date_created,
       blacklisted_by_user, scheme, date_last_used) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.origin_url,
      row.username_value,
      row.password_value,
      row.signon_realm,
      row.date_created,
      row.blacklisted_by_user ?? 0,
      row.date_last_used,
    );
  }
  db.close();
  return filename;
}

function vault() {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-import-vault-"));
  const filename = NodePath.join(directory, "passwords.sqlite");
  const db = PasswordDatabase.open(filename, makeTestCipher());
  cleanups.push(() => {
    db.close();
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, filename };
}

describe("Chrome password import", () => {
  it("imports, dedupes, maps never-save sites, converts times, and stores no plaintext", () => {
    const loginData = fixture([
      {
        origin_url: "https://example.com/login",
        signon_realm: "https://example.com/",
        username_value: "alice",
        password_value: v10("Sentinel-chrome-alice-1"),
        date_created: chromiumTime(NOW - 30 * DAY),
        date_last_used: chromiumTime(NOW - DAY),
      },
      // Bound to its host, as newer Chromium writes.
      {
        origin_url: "https://bound.example/",
        signon_realm: "https://bound.example/",
        username_value: "bea",
        password_value: v10Bound("bound.example", "Sentinel-chrome-bea-2"),
        date_created: chromiumTime(NOW - 5 * DAY),
        date_last_used: 0,
      },
      // Already in BusyBoy with the same password: skipped.
      {
        origin_url: "http://127.0.0.1:4000/login",
        signon_realm: "http://127.0.0.1:4000/",
        username_value: "same",
        password_value: v10("same-pass"),
        date_created: chromiumTime(NOW - 10 * DAY),
        date_last_used: 0,
      },
      // Newer in Chrome than BusyBoy: updated.
      {
        origin_url: "https://update.example/",
        signon_realm: "https://update.example/",
        username_value: "carol",
        password_value: v10("Sentinel-chrome-carol-new"),
        date_created: chromiumTime(NOW - 2 * DAY),
        date_last_used: chromiumTime(NOW - DAY),
      },
      // Older in Chrome than BusyBoy: BusyBoy's copy is kept.
      {
        origin_url: "https://keep.example/",
        signon_realm: "https://keep.example/",
        username_value: "dan",
        password_value: v10("Sentinel-chrome-dan-old"),
        date_created: chromiumTime(NOW - 40 * DAY),
        date_last_used: chromiumTime(NOW - 40 * DAY),
      },
      // Undecryptable (wrong key).
      {
        origin_url: "https://broken.example/",
        signon_realm: "https://broken.example/",
        username_value: "eve",
        password_value: Buffer.concat([Buffer.from("v10"), NodeCrypto.randomBytes(32)]),
        date_created: chromiumTime(NOW - DAY),
        date_last_used: 0,
      },
      // "Never" in Chrome becomes a never-save site.
      {
        origin_url: "https://never.example/",
        signon_realm: "https://never.example/",
        username_value: "",
        password_value: Buffer.alloc(0),
        date_created: chromiumTime(NOW - DAY),
        date_last_used: 0,
        blacklisted_by_user: 1,
      },
      // Not web-form logins: ignored.
      {
        origin_url: "android://hash@com.example.app/",
        signon_realm: "android://hash@com.example.app/",
        username_value: "app",
        password_value: v10("app-pass"),
        date_created: chromiumTime(NOW - DAY),
        date_last_used: 0,
      },
      {
        origin_url: "https://auth.example/",
        signon_realm: "https://auth.example/ Restricted Area",
        username_value: "basic",
        password_value: v10("basic-pass"),
        date_created: chromiumTime(NOW - DAY),
        date_last_used: 0,
      },
    ]);
    const { db, filename } = vault();
    db.add({
      origin: "http://127.0.0.1:4000",
      username: "same",
      password: "same-pass",
      source: "manual",
      createdAt: NOW - 20 * DAY,
    });
    const carol = db.add({
      origin: "https://update.example",
      username: "carol",
      password: "busyboy-carol-old",
      source: "manual",
      createdAt: NOW - 20 * DAY,
    });
    const dan = db.add({
      origin: "https://keep.example",
      username: "dan",
      password: "busyboy-dan-new",
      source: "manual",
      createdAt: NOW - 3 * DAY,
    });

    const plan = planChromiumPasswordImport(
      readChromiumLoginRows(loginData),
      { cbcV10: TEST_KEY },
      "darwin",
    );
    const summary = importIntoVault(db, plan, NOW);

    expect(summary).toEqual({ imported: 2, updated: 1, skipped: 2, failed: 1, neverSave: 1 });
    expect(db.revealPassword(carol)).toBe("Sentinel-chrome-carol-new");
    expect(db.revealPassword(dan)).toBe("busyboy-dan-new");
    const alice = db.find("https://example.com", "alice")!;
    expect(alice).toMatchObject({
      source: "imported_chrome",
      createdAt: NOW - 30 * DAY,
      lastUsedAt: NOW - DAY,
    });
    expect(db.revealPassword(alice.id)).toBe("Sentinel-chrome-alice-1");
    expect(db.revealPassword(db.find("https://bound.example", "bea")!.id)).toBe(
      "Sentinel-chrome-bea-2",
    );
    expect(db.isNeverSave("https://never.example")).toBe(true);
    expect(db.find("https://auth.example", "basic")).toBeNull();

    // A second import adds nothing.
    expect(importIntoVault(db, plan, NOW)).toMatchObject({ imported: 0, updated: 0, neverSave: 0 });

    db.close();
    const bytes = readDatabaseBytes(
      (path) => (NodeFs.existsSync(path) ? NodeFs.readFileSync(path) : null),
      filename,
    );
    for (const sentinel of [
      "Sentinel-chrome-alice-1",
      "Sentinel-chrome-bea-2",
      "Sentinel-chrome-carol-new",
    ]) {
      expect(containsSecret(bytes, sentinel)).toBe(false);
    }
  });

  it("keeps the newest of Chrome's own duplicates", () => {
    const loginData = fixture([
      {
        origin_url: "https://example.com/a",
        signon_realm: "https://example.com/",
        username_value: "alice",
        password_value: v10("older"),
        date_created: chromiumTime(NOW - 9 * DAY),
        date_last_used: 0,
      },
      {
        origin_url: "https://example.com/b",
        signon_realm: "https://example.com/",
        username_value: "alice",
        password_value: v10("newer"),
        date_created: chromiumTime(NOW - 9 * DAY),
        date_last_used: chromiumTime(NOW - DAY),
      },
    ]);
    const plan = planChromiumPasswordImport(
      readChromiumLoginRows(loginData),
      { cbcV10: TEST_KEY },
      "darwin",
    );
    expect(plan.logins).toEqual([
      expect.objectContaining({ origin: "https://example.com", password: "newer" }),
    ]);
  });

  it("converts Chromium times and realms", () => {
    expect(chromiumTimeToEpochMs(chromiumTime(NOW))).toBe(NOW);
    expect(chromiumTimeToEpochMs(0n)).toBeNull();
    expect(realmToOrigin("https://example.com:8443/")).toBe("https://example.com:8443");
    expect(realmToOrigin("https://example.com/ Realm")).toBeNull();
    expect(realmToOrigin("android://x@y/")).toBeNull();
  });
});
