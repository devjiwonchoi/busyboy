// @effect-diagnostics nodeBuiltinImport:off - Tests use temp-dir node:sqlite files.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { DuplicateLoginError, PasswordDatabase } from "./PasswordDatabase.ts";
import { containsSecret, makeTestCipher, readDatabaseBytes } from "./testCipher.ts";

const SENTINEL = "Sentinel-Pa55word-7f3c9e";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openVault() {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-vault-"));
  const filename = NodePath.join(directory, "passwords.sqlite");
  const cipher = makeTestCipher();
  const db = PasswordDatabase.open(filename, cipher);
  cleanups.push(() => {
    db.close();
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, filename, cipher };
}

const read = (path: string) => (NodeFs.existsSync(path) ? NodeFs.readFileSync(path) : null);

describe("PasswordDatabase", () => {
  it("never writes a password or note in plaintext, in the database, WAL or SHM", () => {
    const { db, filename } = openVault();
    const id = db.add({
      origin: "https://example.com",
      username: "alice",
      password: SENTINEL,
      note: `note ${SENTINEL}-note`,
      source: "manual",
      createdAt: 1,
    });
    db.update(id, { password: `${SENTINEL}-changed` }, 2);
    // Bytes while the WAL is still live, then after closing.
    expect(containsSecret(readDatabaseBytes(read, filename), SENTINEL)).toBe(false);
    db.close();
    const bytes = readDatabaseBytes(read, filename);
    expect(bytes.length).toBeGreaterThan(0);
    expect(containsSecret(bytes, SENTINEL)).toBe(false);
    expect(containsSecret(bytes, "alice")).toBe(true);
  });

  it("adds, lists without decrypting, reveals one row, updates and removes", () => {
    const { db, cipher } = openVault();
    const a = db.add({
      origin: "https://a.example",
      username: "alice",
      password: "pw-a",
      source: "manual",
      createdAt: 10,
    });
    db.add({
      origin: "https://b.example",
      username: "bob@b.example",
      password: "pw-b",
      note: "desk",
      source: "saved",
      createdAt: 20,
    });

    expect(db.list().map((login) => [login.origin, login.username, login.hasNote])).toEqual([
      ["https://a.example", "alice", false],
      ["https://b.example", "bob@b.example", true],
    ]);
    expect(db.list("BOB").map((login) => login.username)).toEqual(["bob@b.example"]);
    expect(db.list("a.example").map((login) => login.username)).toEqual(["alice"]);
    expect(cipher.calls.decrypt).toBe(0);
    expect(JSON.stringify(db.list())).not.toContain("pw-");

    expect(db.revealPassword(a)).toBe("pw-a");
    expect(cipher.calls.decrypt).toBe(1);
    expect(db.update(a, { username: "alice2", password: "pw-a2", note: "n" }, 30)).toBe(true);
    expect(db.get(a)).toMatchObject({ username: "alice2", updatedAt: 30, hasNote: true });
    expect(db.revealPassword(a)).toBe("pw-a2");
    expect(db.revealNote(a)).toBe("n");
    db.update(a, { note: "" }, 31);
    expect(db.get(a)?.hasNote).toBe(false);

    expect(db.remove([a])).toBe(1);
    expect(db.get(a)).toBeNull();
    expect(db.update(a, { username: "x" }, 40)).toBe(false);
    expect(db.removeAll()).toBe(1);
    expect(db.list()).toEqual([]);
  });

  it("keeps one login per site and username", () => {
    const { db } = openVault();
    const login = {
      origin: "https://example.com",
      username: "alice",
      password: "one",
      source: "manual" as const,
      createdAt: 1,
    };
    const first = db.add(login);
    expect(() => db.add({ ...login, password: "two" })).toThrow(DuplicateLoginError);
    const other = db.add({ ...login, username: "bob" });
    expect(() => db.update(other, { username: "alice" }, 2)).toThrow(DuplicateLoginError);
    // Same username on another site is fine.
    db.add({ ...login, origin: "https://other.example" });
    expect(db.revealPassword(first)).toBe("one");
  });

  it("records, lists and removes never-save sites", () => {
    const { db } = openVault();
    db.addNeverSave("https://b.example", 2);
    db.addNeverSave("https://a.example", 1);
    db.addNeverSave("https://a.example", 3);
    expect(db.isNeverSave("https://a.example")).toBe(true);
    const entries = db.neverSaveList();
    expect(entries.map((entry) => entry.origin)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    db.removeNeverSave([entries[0]!.id]);
    expect(db.isNeverSave("https://a.example")).toBe(false);
  });
});
