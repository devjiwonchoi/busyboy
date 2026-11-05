// @effect-diagnostics nodeBuiltinImport:off - The vault is a synchronous node:sqlite database.
import type {
  BrowserLoginSource,
  BrowserLoginSummary,
  BrowserNeverSaveEntry,
} from "@t3tools/contracts";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const PASSWORD_SCHEMA_VERSION = 1;

/**
 * Encrypts secrets before they reach SQLite. In the app this is Electron
 * safeStorage (a Keychain-protected key on macOS); nothing is ever stored in
 * plaintext.
 */
export interface SecretCipher {
  readonly encrypt: (plaintext: string) => Uint8Array;
  readonly decrypt: (ciphertext: Uint8Array) => string;
}

const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE logins (
    id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL,
    signon_realm TEXT NOT NULL,
    action_origin TEXT,
    username TEXT NOT NULL,
    username_field TEXT,
    password_field TEXT,
    password_encrypted BLOB NOT NULL,
    note_encrypted BLOB,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_filled_at INTEGER,
    times_used INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    UNIQUE (signon_realm, username)
  );
  CREATE INDEX logins_signon_realm ON logins(signon_realm);
  CREATE TABLE never_save (
    id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  `,
];

export interface NewLogin {
  readonly origin: string;
  readonly signonRealm?: string | undefined;
  readonly actionOrigin?: string | null | undefined;
  readonly username: string;
  readonly usernameField?: string | null | undefined;
  readonly passwordField?: string | null | undefined;
  readonly password: string;
  readonly note?: string | null | undefined;
  readonly source: BrowserLoginSource;
  readonly createdAt: number;
  readonly lastUsedAt?: number | null | undefined;
}

interface LoginRow {
  readonly id: number;
  readonly origin: string;
  readonly signon_realm: string;
  readonly username: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_used_at: number | null;
  readonly last_filled_at: number | null;
  readonly times_used: number;
  readonly source: BrowserLoginSource;
  readonly has_note: number;
}

const SUMMARY_COLUMNS = `id, origin, signon_realm, username, created_at, updated_at, last_used_at,
  last_filled_at, times_used, source, note_encrypted IS NOT NULL AS has_note`;

const toSummary = (row: LoginRow): BrowserLoginSummary => ({
  id: row.id,
  origin: row.origin,
  signonRealm: row.signon_realm,
  username: row.username,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastUsedAt: row.last_used_at,
  lastFilledAt: row.last_filled_at,
  timesUsed: row.times_used,
  source: row.source,
  hasNote: row.has_note === 1,
});

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

export class DuplicateLoginError extends Error {
  readonly existingId: number;
  constructor(existingId: number) {
    super("A saved login for this site and username already exists.");
    this.name = "DuplicateLoginError";
    this.existingId = existingId;
  }
}

/**
 * One profile's password vault. Listing never decrypts; only `revealPassword`
 * and `revealNote` do, one row at a time.
 */
export class PasswordDatabase {
  private readonly db: DatabaseSync;
  private readonly cipher: SecretCipher;

  private constructor(db: DatabaseSync, cipher: SecretCipher) {
    this.db = db;
    this.cipher = cipher;
  }

  static open(filename: string, cipher: SecretCipher): PasswordDatabase {
    const db = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 2000");
      // Freed pages are zeroed so deleted ciphertext does not linger in the file.
      db.exec("PRAGMA secure_delete = ON");
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      const current = row === undefined ? 0 : Number(row.value);
      if (!Number.isInteger(current) || current > PASSWORD_SCHEMA_VERSION) {
        throw new Error(`Unsupported password schema version ${row?.value}.`);
      }
      for (let version = current; version < PASSWORD_SCHEMA_VERSION; version += 1) {
        db.exec("BEGIN");
        try {
          db.exec(MIGRATIONS[version]!);
          db.prepare(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          ).run(String(version + 1));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return new PasswordDatabase(db, cipher);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  transaction<A>(body: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(query?: string): ReadonlyArray<BrowserLoginSummary> {
    const terms = query?.trim() ?? "";
    const params: SQLInputValue[] = [];
    let where = "";
    if (terms.length > 0) {
      where = "WHERE origin LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\'";
      const pattern = `%${escapeLike(terms)}%`;
      params.push(pattern, pattern);
    }
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM logins ${where} ORDER BY origin COLLATE NOCASE, username COLLATE NOCASE, id`,
      )
      .all(...params) as unknown as LoginRow[];
    return rows.map(toSummary);
  }

  get(id: number): BrowserLoginSummary | null {
    const row = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM logins WHERE id = ?`).get(id) as
      | LoginRow
      | undefined;
    return row === undefined ? null : toSummary(row);
  }

  find(signonRealm: string, username: string): BrowserLoginSummary | null {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM logins WHERE signon_realm = ? AND username = ?`)
      .get(signonRealm, username) as LoginRow | undefined;
    return row === undefined ? null : toSummary(row);
  }

  /** Inserts a login. Throws DuplicateLoginError when (realm, username) exists. */
  add(login: NewLogin): number {
    const realm = login.signonRealm ?? login.origin;
    const existing = this.find(realm, login.username);
    if (existing !== null) throw new DuplicateLoginError(existing.id);
    const result = this.db
      .prepare(
        `INSERT INTO logins (origin, signon_realm, action_origin, username, username_field,
           password_field, password_encrypted, note_encrypted, created_at, updated_at,
           last_used_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        login.origin,
        realm,
        login.actionOrigin ?? null,
        login.username,
        login.usernameField ?? null,
        login.passwordField ?? null,
        this.cipher.encrypt(login.password),
        login.note ? this.cipher.encrypt(login.note) : null,
        login.createdAt,
        login.createdAt,
        login.lastUsedAt ?? null,
        login.source,
      );
    return Number(result.lastInsertRowid);
  }

  /** Returns false when the login does not exist. Throws DuplicateLoginError on a username clash. */
  update(
    id: number,
    changes: {
      readonly username?: string | undefined;
      readonly password?: string | undefined;
      readonly note?: string | undefined;
    },
    at: number,
  ): boolean {
    const current = this.get(id);
    if (current === null) return false;
    if (changes.username !== undefined && changes.username !== current.username) {
      const clash = this.find(current.signonRealm, changes.username);
      if (clash !== null) throw new DuplicateLoginError(clash.id);
    }
    const sets: string[] = ["updated_at = ?"];
    const params: SQLInputValue[] = [at];
    if (changes.username !== undefined) {
      sets.push("username = ?");
      params.push(changes.username);
    }
    if (changes.password !== undefined) {
      sets.push("password_encrypted = ?");
      params.push(this.cipher.encrypt(changes.password));
    }
    if (changes.note !== undefined) {
      sets.push("note_encrypted = ?");
      params.push(changes.note.length === 0 ? null : this.cipher.encrypt(changes.note));
    }
    this.db.prepare(`UPDATE logins SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return true;
  }

  remove(ids: ReadonlyArray<number>): number {
    if (ids.length === 0) return 0;
    return this.transaction(() => {
      const statement = this.db.prepare("DELETE FROM logins WHERE id = ?");
      let removed = 0;
      for (const id of ids) removed += Number(statement.run(id).changes);
      return removed;
    });
  }

  removeAll(): number {
    return Number(this.db.prepare("DELETE FROM logins").run().changes);
  }

  /** Decrypts one password for one operation. The caller must not keep or log it. */
  revealPassword(id: number): string | null {
    const row = this.db.prepare("SELECT password_encrypted FROM logins WHERE id = ?").get(id) as
      | { password_encrypted: Uint8Array }
      | undefined;
    return row === undefined ? null : this.cipher.decrypt(row.password_encrypted);
  }

  revealNote(id: number): string | null {
    const row = this.db.prepare("SELECT note_encrypted FROM logins WHERE id = ?").get(id) as
      | { note_encrypted: Uint8Array | null }
      | undefined;
    if (row === undefined) return null;
    return row.note_encrypted === null ? "" : this.cipher.decrypt(row.note_encrypted);
  }

  /** Logins for one realm, most recently used first (fill dropdown order). */
  forRealm(signonRealm: string): ReadonlyArray<BrowserLoginSummary> {
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM logins WHERE signon_realm = ?
         ORDER BY IFNULL(last_used_at, 0) DESC, IFNULL(last_filled_at, 0) DESC, id`,
      )
      .all(signonRealm) as unknown as LoginRow[];
    return rows.map(toSummary);
  }

  /** True when the stored password for this login equals `candidate`. Decrypts one row. */
  passwordEquals(id: number, candidate: string): boolean {
    return this.revealPassword(id) === candidate;
  }

  /** A sign-in with this login succeeded. */
  recordUse(id: number, at: number): void {
    this.db
      .prepare("UPDATE logins SET last_used_at = ?, times_used = times_used + 1 WHERE id = ?")
      .run(at, id);
  }

  recordFill(id: number, at: number): void {
    this.db.prepare("UPDATE logins SET last_filled_at = ? WHERE id = ?").run(at, id);
  }

  neverSaveList(): ReadonlyArray<BrowserNeverSaveEntry> {
    const rows = this.db
      .prepare("SELECT id, origin, created_at FROM never_save ORDER BY origin COLLATE NOCASE")
      .all() as unknown as Array<{ id: number; origin: string; created_at: number }>;
    return rows.map((row) => ({ id: row.id, origin: row.origin, createdAt: row.created_at }));
  }

  isNeverSave(origin: string): boolean {
    return this.db.prepare("SELECT 1 FROM never_save WHERE origin = ?").get(origin) !== undefined;
  }

  addNeverSave(origin: string, at: number): void {
    this.db
      .prepare(
        "INSERT INTO never_save (origin, created_at) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING",
      )
      .run(origin, at);
  }

  removeNeverSave(ids: ReadonlyArray<number>): number {
    if (ids.length === 0) return 0;
    return this.transaction(() => {
      const statement = this.db.prepare("DELETE FROM never_save WHERE id = ?");
      let removed = 0;
      for (const id of ids) removed += Number(statement.run(id).changes);
      return removed;
    });
  }
}
