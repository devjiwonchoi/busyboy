import { ChromeHistoryImportFailureReason } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  BROWSER_IMPORT_SOURCES,
  listSourceProfiles,
  sourcePathContext,
} from "../BrowserImport/Sources.ts";
import * as BrowsingHistory from "./BrowsingHistory.ts";
import { HISTORY_MAX_AGE_MS, type HistoryEntry } from "./HistoryRanking.ts";

/** Milliseconds between 1601-01-01 (Chrome's epoch) and 1970-01-01. */
const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;

export class ChromeHistoryImportError extends Schema.TaggedError<ChromeHistoryImportError>()(
  "ChromeHistoryImportError",
  {
    reason: ChromeHistoryImportFailureReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The reason token is part of the message on purpose: IPC flattens the error
  // to its message, and the renderer maps that token back to user-facing copy.
  override get message(): string {
    return `Importing Chrome history failed: ${this.reason}.`;
  }
}

const UrlRow = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  visit_count: Schema.Number,
  last_visit: Schema.Number,
});
const decodeUrlRows = Schema.decodeUnknownEffect(Schema.Array(UrlRow));

/**
 * Reads visited pages newer than `since` (ms since the epoch). Chrome stores
 * microseconds since 1601, which overflows JavaScript's safe integers, so the
 * conversion happens in SQL. Hidden rows are subframe and redirect URLs Chrome
 * never suggests either.
 */
export const readChromeHistoryDatabase = Effect.fn("ChromeHistory.readChromeHistoryDatabase")(
  function* ({ snapshotPath, since }: { readonly snapshotPath: string; readonly since: number }) {
    // Opened writable: it is our own copy, and SQLite must be able to roll back
    // a write Chrome had in flight when the copy was taken.
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* decodeUrlRows(
        yield* sql`select url, title, visit_count,
            last_visit_time / 1000 - ${WEBKIT_EPOCH_OFFSET_MS} as last_visit
          from urls
          where hidden = 0 and last_visit_time / 1000 - ${WEBKIT_EPOCH_OFFSET_MS} >= ${since}`,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })));

    return rows.map((row): HistoryEntry => ({
      url: row.url,
      title: row.title,
      visitCount: Math.max(row.visit_count, 1),
      lastVisit: row.last_visit,
    }));
  },
);

/**
 * Chrome locks `History` while it runs, which blocks opening it but not a
 * plain copy, so the file (and any journal or WAL beside it) is copied first.
 */
const copyChromeDatabase = Effect.fn("ChromeHistory.copyChromeDatabase")(function* (
  databasePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-history-import-",
  });
  const target = path.join(directory, "History");
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

/** Imports recent history from every Chrome profile into the browser's history. */
export const importChromeHistory = Effect.fn("ChromeHistory.importChromeHistory")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const history = yield* BrowsingHistory.BrowsingHistory;
  const pathContext = yield* sourcePathContext;
  const chrome = BROWSER_IMPORT_SOURCES.find((definition) => definition.id === "chrome");
  const root = chrome?.userDataDirectory(pathContext);
  if (chrome === undefined || root === undefined || !chrome.platforms.includes(platform)) {
    return yield* new ChromeHistoryImportError({ reason: "unsupportedPlatform" });
  }

  const profiles = yield* listSourceProfiles(chrome, pathContext);
  const databases = yield* Effect.filter(
    profiles.map((profile) => pathContext.path.join(root, profile.directory, "History")),
    (databasePath) =>
      fileSystem.stat(databasePath).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      ),
  );
  if (databases.length === 0) {
    return yield* new ChromeHistoryImportError({ reason: "notInstalled" });
  }

  const since = (yield* Clock.currentTimeMillis) - HISTORY_MAX_AGE_MS;
  const entries = yield* Effect.forEach(databases, (databasePath) =>
    // A copy taken mid-write can be torn; a fresh one a moment later is not.
    copyChromeDatabase(databasePath).pipe(
      Effect.flatMap((snapshotPath) => readChromeHistoryDatabase({ snapshotPath, since })),
      Effect.retry({ times: 2, schedule: Schedule.spaced("200 millis") }),
      Effect.scoped,
      Effect.mapError((cause) => new ChromeHistoryImportError({ reason: "readFailed", cause })),
    ),
  );

  return yield* history
    .importEntries(entries.flat())
    .pipe(
      Effect.mapError((cause) => new ChromeHistoryImportError({ reason: "saveFailed", cause })),
    );
});
