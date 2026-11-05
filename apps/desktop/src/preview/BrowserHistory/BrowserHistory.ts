// @effect-diagnostics nodeBuiltinImport:off - Opens per-profile node:sqlite files synchronously.
import type {
  BrowserHistoryClearRange,
  BrowserHistoryImportLegacyResult,
  BrowserHistoryLegacyEntry,
  BrowserHistoryRecentEntry,
  BrowserHistoryRemoveInput,
  BrowserHistorySearchInput,
  BrowserHistorySearchResult,
  BrowserHistoryStatus,
} from "@t3tools/contracts";
import { DEFAULT_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { HISTORY_RETENTION_MS, HistoryDatabase, type NewVisit } from "./HistoryDatabase.ts";
import { HistoryRecorder, type AgentAttribution } from "./HistoryRecorder.ts";
import { importLegacyOriginHistoryOnce } from "./LegacyOriginHistory.ts";

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DELETION_LOCKED_ENV = "BUSYBOY_BROWSER_HISTORY_DELETION_LOCKED";

const RANGE_MS: Readonly<Record<Exclude<BrowserHistoryClearRange, "all">, number>> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  four_weeks: 28 * 24 * 60 * 60 * 1000,
};

export function clearRangeStart(range: BrowserHistoryClearRange, now: number): number | null {
  return range === "all" ? null : now - RANGE_MS[range];
}

export class BrowserHistoryUnavailableError extends Schema.TaggedError<BrowserHistoryUnavailableError>()(
  "BrowserHistoryUnavailableError",
  { profileId: Schema.String },
) {
  override get message(): string {
    return `Browsing history is unavailable for browser profile ${this.profileId}.`;
  }
}

export class BrowserHistoryDeletionLockedError extends Schema.TaggedError<BrowserHistoryDeletionLockedError>()(
  "BrowserHistoryDeletionLockedError",
  {},
) {
  override get message(): string {
    return "Removing browsing history is turned off on this device.";
  }
}

export class BrowserHistoryOperationError extends Schema.TaggedError<BrowserHistoryOperationError>()(
  "BrowserHistoryOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Browsing history ${this.operation} failed.`;
  }
}

export type BrowserHistoryError =
  | BrowserHistoryUnavailableError
  | BrowserHistoryDeletionLockedError
  | BrowserHistoryOperationError;

export interface BrowserHistoryGuestOptions {
  /** Non-null when an agent drove this guest within the attribution window. */
  readonly agentAttribution: () => AgentAttribution | null;
}

export interface BrowserHistoryShape {
  /**
   * Remembers which profile a session belongs to. Only sessions registered as
   * persistent are ever recorded; incognito and unknown sessions are not.
   */
  readonly registerSession: (
    session: object,
    profile: { readonly profileId: string; readonly persistent: boolean },
  ) => void;
  /** A recorder for one guest, or null when its session must not be recorded. */
  readonly recorderFor: (
    session: object,
    options: BrowserHistoryGuestOptions,
  ) => HistoryRecorder | null;
  readonly search: (
    input: BrowserHistorySearchInput,
  ) => Effect.Effect<BrowserHistorySearchResult, BrowserHistoryError>;
  readonly recent: (input: {
    readonly profileId: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<BrowserHistoryRecentEntry>, BrowserHistoryError>;
  readonly remove: (input: BrowserHistoryRemoveInput) => Effect.Effect<void, BrowserHistoryError>;
  /** Clears visits in the range. Clearing all time also deletes the database files. */
  readonly clearHistory: (input: {
    readonly profileId: string;
    readonly range: BrowserHistoryClearRange;
  }) => Effect.Effect<void, BrowserHistoryError>;
  readonly importLegacy: (
    entries: ReadonlyArray<BrowserHistoryLegacyEntry>,
  ) => Effect.Effect<BrowserHistoryImportLegacyResult, BrowserHistoryError>;
  readonly status: (profileId: string) => Effect.Effect<BrowserHistoryStatus>;
  readonly deletionLocked: boolean;
  readonly subscribeChanges: (listener: (profileId: string) => void) => () => void;
  /** Waits for queued visit writes; for tests and shutdown. */
  readonly flushWrites: Effect.Effect<void>;
}

export class BrowserHistory extends Context.Service<BrowserHistory, BrowserHistoryShape>()(
  "@t3tools/desktop/preview/BrowserHistory/BrowserHistory",
) {}

export const profileDirectoryName = (profileId: string): string =>
  NodeCrypto.createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 32);

export interface MakeBrowserHistoryOptions {
  readonly rootDirectory: string;
  readonly deletionLocked: boolean;
  readonly now?: () => number;
  /** Defaults to `setImmediate`; tests can run writes synchronously. */
  readonly schedule?: (task: () => void) => void;
  readonly onError?: (message: string, cause: unknown) => void;
}

/**
 * Plain constructor so the store can be exercised without Electron. The layer
 * below only supplies paths and logging.
 */
export function makeBrowserHistory(options: MakeBrowserHistoryOptions): BrowserHistoryShape & {
  /** Drops visits past the retention window from every open profile. */
  readonly prune: () => void;
  readonly close: () => void;
} {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((task: () => void) => void setImmediate(task));
  const onError = options.onError ?? (() => {});
  type SessionProfile = { profileId: string; persistent: boolean };
  // Keyed by the session's on-disk path when it has one: Electron does not
  // promise that `webContents.session` is the same object `fromPartition`
  // returned. In-memory (incognito) sessions have no path and fall back to
  // identity, which only matters for telling them apart from unknown ones.
  const sessionsByPath = new Map<string, SessionProfile>();
  const sessionsByObject = new WeakMap<object, SessionProfile>();
  const storagePathOf = (session: object): string | null => {
    const value = (session as { readonly storagePath?: unknown }).storagePath;
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const databases = new Map<string, HistoryDatabase | "failed">();
  const listeners = new Set<(profileId: string) => void>();
  const queue: Array<() => void> = [];
  const drained: Array<() => void> = [];
  let flushScheduled = false;

  const databasePath = (profileId: string) =>
    NodePath.join(options.rootDirectory, profileDirectoryName(profileId), "history.sqlite");

  const emit = (profileId: string) => {
    for (const listener of listeners) {
      try {
        listener(profileId);
      } catch (cause) {
        onError("A browsing history change listener failed.", cause);
      }
    }
  };

  const database = (profileId: string): HistoryDatabase | null => {
    const existing = databases.get(profileId);
    if (existing === "failed") return null;
    if (existing !== undefined) return existing;
    try {
      const filename = databasePath(profileId);
      NodeFs.mkdirSync(NodePath.dirname(filename), { recursive: true });
      const opened = HistoryDatabase.open(filename);
      opened.prune(now());
      databases.set(profileId, opened);
      return opened;
    } catch (cause) {
      // Browsing continues without history; Settings shows the notice via `status`.
      databases.set(profileId, "failed");
      onError(`Could not open browsing history for profile ${profileId}.`, cause);
      return null;
    }
  };

  const pruneOpenDatabases = () => {
    const at = now();
    for (const [profileId, db] of databases) {
      if (db === "failed") continue;
      try {
        if (db.prune(at) > 0) emit(profileId);
      } catch (cause) {
        onError("Pruning browsing history failed.", cause);
      }
    }
  };

  const runQueue = () => {
    flushScheduled = false;
    const tasks = queue.splice(0);
    for (const task of tasks) {
      try {
        task();
      } catch (cause) {
        onError("Writing browsing history failed.", cause);
      }
    }
    for (const resolve of drained.splice(0)) resolve();
  };

  const enqueue = (task: () => void) => {
    queue.push(task);
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(runQueue);
  };

  const writeVisit = (profileId: string, visit: NewVisit) =>
    enqueue(() => {
      const db = database(profileId);
      if (db?.recordVisit(visit) != null) emit(profileId);
    });

  const writeTitle = (profileId: string, url: string, title: string) =>
    enqueue(() => {
      if (database(profileId)?.setTitle(url, title)) emit(profileId);
    });

  const use = <A>(
    operation: string,
    profileId: string,
    body: (db: HistoryDatabase) => A,
  ): Effect.Effect<A, BrowserHistoryError> =>
    Effect.suspend((): Effect.Effect<A, BrowserHistoryError> => {
      const db = database(profileId);
      if (db === null) return Effect.fail(new BrowserHistoryUnavailableError({ profileId }));
      return Effect.try({
        try: () => body(db),
        catch: (cause) => new BrowserHistoryOperationError({ operation, cause }),
      });
    });

  const requireUnlocked = options.deletionLocked
    ? Effect.fail(new BrowserHistoryDeletionLockedError())
    : Effect.void;

  const deleteDatabaseFiles = (profileId: string) => {
    const existing = databases.get(profileId);
    if (existing !== undefined && existing !== "failed") existing.close();
    databases.delete(profileId);
    NodeFs.rmSync(NodePath.dirname(databasePath(profileId)), { recursive: true, force: true });
  };

  return {
    registerSession: (session, profile) => {
      const entry = { profileId: profile.profileId, persistent: profile.persistent };
      const storagePath = storagePathOf(session);
      if (storagePath !== null) sessionsByPath.set(storagePath, entry);
      sessionsByObject.set(session, entry);
    },
    recorderFor: (session, guestOptions) => {
      const storagePath = storagePathOf(session);
      const profile =
        (storagePath === null ? undefined : sessionsByPath.get(storagePath)) ??
        sessionsByObject.get(session);
      if (profile === undefined || !profile.persistent) return null;
      const { profileId } = profile;
      return new HistoryRecorder({
        now,
        agentAttribution: guestOptions.agentAttribution,
        record: (visit) => writeVisit(profileId, visit),
        setTitle: (url, title) => writeTitle(profileId, url, title),
      });
    },
    search: (input) =>
      use("search", input.profileId, (db) =>
        db.search({
          query: input.query,
          source: input.source,
          before: input.before,
          limit: input.limit,
        }),
      ),
    recent: (input) => use("recent", input.profileId, (db) => db.recent(input.limit)),
    remove: (input) =>
      requireUnlocked.pipe(
        Effect.andThen(
          use("remove", input.profileId, (db) =>
            db.remove({ visitIds: input.visitIds, urls: input.urls }),
          ),
        ),
        Effect.tap(() => Effect.sync(() => emit(input.profileId))),
        Effect.asVoid,
      ),
    clearHistory: (input) =>
      requireUnlocked.pipe(
        Effect.andThen(
          input.range === "all"
            ? Effect.try({
                try: () => deleteDatabaseFiles(input.profileId),
                catch: (cause) => new BrowserHistoryOperationError({ operation: "clear", cause }),
              })
            : use("clear", input.profileId, (db) =>
                db.clearSince(clearRangeStart(input.range, now())),
              ),
        ),
        Effect.tap(() => Effect.sync(() => emit(input.profileId))),
        Effect.asVoid,
      ),
    importLegacy: (entries) =>
      use("importLegacy", DEFAULT_BROWSER_PROFILE_ID, (db) => {
        return { imported: db.importLegacy(entries, now() - HISTORY_RETENTION_MS) };
      }).pipe(Effect.tap(() => Effect.sync(() => emit(DEFAULT_BROWSER_PROFILE_ID)))),
    status: (profileId) =>
      Effect.sync(() => ({
        available: database(profileId) !== null,
        deletionLocked: options.deletionLocked,
      })),
    deletionLocked: options.deletionLocked,
    subscribeChanges: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flushWrites: Effect.callback<void>((resume) => {
      if (queue.length === 0 && !flushScheduled) {
        resume(Effect.void);
        return;
      }
      drained.push(() => resume(Effect.void));
    }),
    prune: pruneOpenDatabases,
    close: () => {
      runQueue();
      for (const db of databases.values()) if (db !== "failed") db.close();
      databases.clear();
    },
  };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const reported = new Set<string>();
  const rootDirectory = environment.path.join(environment.stateDir, "BrowserProfiles");
  const history = makeBrowserHistory({
    rootDirectory,
    deletionLocked: process.env[DELETION_LOCKED_ENV] === "1",
    onError: (message, cause) => {
      // Log each kind of failure once; a broken disk would otherwise log per navigation.
      if (reported.has(message)) return;
      reported.add(message);
      runFork(Effect.logWarning(message, { cause }));
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(history.close));
  // History an older build kept under the renderer's previous origin.
  yield* Effect.promise(() =>
    importLegacyOriginHistoryOnce({
      rootDirectory,
      isDevelopment: environment.isDevelopment,
      importLegacy: async (entries) => {
        await Effect.runPromise(history.importLegacy(entries));
      },
      onError: (cause) =>
        runFork(Effect.logWarning("legacy browsing history import failed", { cause })),
    }),
  ).pipe(Effect.forkScoped);
  // Each database is pruned when it opens; this covers long-running sessions.
  yield* Effect.sync(history.prune).pipe(
    Effect.delay(Duration.millis(PRUNE_INTERVAL_MS)),
    Effect.forever,
    Effect.forkScoped,
  );
  return BrowserHistory.of(history);
});

export const layer = Layer.effect(BrowserHistory, make);
