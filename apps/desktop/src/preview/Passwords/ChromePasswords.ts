import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { decryptChromiumValue } from "../BrowserImport/ChromiumCookies.ts";
import { ChromiumKeyFailure, type ChromiumKeyMaterial } from "../BrowserImport/ChromiumKeys.ts";
import { passwordOrigin, type ImportedPassword, type PasswordReadResult } from "./PasswordEntry.ts";

/**
 * `Login Data` holds passwords saved on this device; `Login Data For Account`
 * holds the ones Chrome keeps in the signed-in Google account.
 */
export const CHROME_PASSWORD_DATABASE_NAMES = ["Login Data", "Login Data For Account"] as const;

export class ChromePasswordReadError extends Schema.TaggedError<ChromePasswordReadError>()(
  "ChromePasswordReadError",
  {
    reason: ChromiumKeyFailure,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read Chrome passwords: ${this.reason}.`;
  }
}

const CHROMIUM_KEY_NAMES = ["cbcV10", "cbcV11", "cbcEmpty", "gcmV10"] as const;

/** Keys as base64 strings, so they can be kept in the encrypted vault. */
export const encodeChromiumKeys = (keys: ChromiumKeyMaterial): Record<string, string> => {
  const encoded: Record<string, string> = {};
  for (const name of CHROMIUM_KEY_NAMES) {
    const key = keys[name];
    if (key !== undefined) {
      encoded[name] = key.toString("base64");
    }
  }
  return encoded;
};

export const decodeChromiumKeys = (encoded: Readonly<Record<string, string>>) => {
  const key = (name: (typeof CHROMIUM_KEY_NAMES)[number]) => {
    const value = encoded[name];
    return value === undefined ? {} : { [name]: Buffer.from(value, "base64") };
  };
  return {
    ...key("cbcV10"),
    ...key("cbcV11"),
    ...key("cbcEmpty"),
    ...key("gcmV10"),
  } satisfies ChromiumKeyMaterial;
};

const LoginRow = Schema.Struct({
  origin_url: Schema.String,
  username_value: Schema.String,
  password_value: Schema.Uint8Array,
});
const decodeLoginRows = Schema.decodeUnknownEffect(Schema.Array(LoginRow));

/**
 * Passwords use the same OSCrypt key and `v10`/`v11` envelope as cookies, but
 * carry no domain-binding prefix, so they decrypt as schema version 0.
 */
export const readChromePasswordDatabase = Effect.fn("ChromePasswords.readChromePasswordDatabase")(
  function* ({
    snapshotPath,
    keys,
    platform,
  }: {
    readonly snapshotPath: string;
    readonly keys: ChromiumKeyMaterial;
    readonly platform: NodeJS.Platform;
  }) {
    // Opened writable: it is our own copy, and SQLite must be able to roll back
    // a write Chrome had in flight when the copy was taken. A copy that still
    // fails the integrity check is rejected so the caller can take another.
    // Rows the user marked "Never save" have no password and are left out.
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [check] = yield* sql<{ readonly quick_check: string }>`pragma quick_check`;
      if (check?.quick_check !== "ok") {
        return yield* new ChromePasswordReadError({ reason: "readFailed" });
      }
      return yield* decodeLoginRows(
        yield* sql`select origin_url, username_value, password_value from logins
          where blacklisted_by_user = 0`,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })));

    const passwords: ImportedPassword[] = [];
    let skipped = 0;
    for (const row of rows) {
      const origin = passwordOrigin(row.origin_url);
      const password =
        origin === undefined
          ? null
          : decryptChromiumValue(row.password_value, keys, origin, 0, platform);
      if (origin === undefined || password === null || password === "") {
        skipped += 1;
        continue;
      }
      passwords.push({ origin, username: row.username_value, password });
    }

    return { passwords, skipped } satisfies PasswordReadResult;
  },
);

/**
 * Copies the database (and any rollback journal or WAL beside it) instead of
 * opening it: Chrome keeps it locked while it runs, which blocks `VACUUM INTO`
 * but not a plain file copy, so this works without quitting Chrome.
 */
const copyChromeDatabase = Effect.fn("ChromePasswords.copyChromeDatabase")(function* (
  databasePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-password-import-",
  });
  const target = path.join(directory, "Login Data");
  yield* fileSystem.copyFile(databasePath, target);
  for (const suffix of ["-journal", "-wal"]) {
    const sidecar = `${databasePath}${suffix}`;
    const present = yield* fileSystem.stat(sidecar).pipe(
      Effect.map((info) => info.type === "File" && Number(info.size) > 0),
      Effect.orElseSucceed(() => false),
    );
    if (present) {
      yield* fileSystem.copyFile(sidecar, `${target}${suffix}`);
    }
  }
  return target;
});

export const readChromePasswords = Effect.fn("ChromePasswords.readChromePasswords")(function* ({
  databasePaths,
  keys,
  platform,
}: {
  readonly databasePaths: ReadonlyArray<string>;
  readonly keys: ChromiumKeyMaterial;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<
  PasswordReadResult,
  ChromePasswordReadError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const passwords: ImportedPassword[] = [];
  let skipped = 0;
  for (const databasePath of databasePaths) {
    // A copy taken mid-write can be torn; a fresh one a moment later is not.
    const read = yield* copyChromeDatabase(databasePath).pipe(
      Effect.flatMap((snapshotPath) =>
        readChromePasswordDatabase({ snapshotPath, keys, platform }),
      ),
      Effect.mapError((cause) => new ChromePasswordReadError({ reason: "readFailed", cause })),
      Effect.retry({ times: 2, schedule: Schedule.spaced("200 millis") }),
    );
    passwords.push(...read.passwords);
    skipped += read.skipped;
  }

  // A key that decrypts nothing is the wrong key, not an empty password store.
  if (passwords.length === 0 && skipped > 0 && keys.cbcV11Error !== undefined) {
    return yield* new ChromePasswordReadError({
      reason: keys.cbcV11Error.reason,
      cause: keys.cbcV11Error,
    });
  }

  return { passwords, skipped };
});
