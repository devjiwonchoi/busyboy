// Adapted from Min (https://github.com/minbrowser/min), js/places/placesService.js,
// licensed under Apache-2.0.
// Modified for Busyboy: history lives in SQLite owned by the desktop main
// process instead of IndexedDB, records preview-tab navigations directly, and
// keeps no page text, tags or bookmarks.

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { WebContents } from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { HISTORY_MAX_AGE_MS, searchHistory, type HistoryEntry } from "./HistoryRanking.ts";

export class BrowsingHistoryError extends Schema.TaggedError<BrowsingHistoryError>()(
  "BrowsingHistoryError",
  {
    operation: Schema.Literals(["open", "read", "write", "clear"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browsing history ${this.operation} failed.`;
  }
}

const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

const PlaceRow = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  visit_count: Schema.Number,
  last_visit: Schema.Number,
});
const decodePlaceRows = Schema.decodeUnknownEffect(Schema.Array(PlaceRow));

/**
 * The URL a visit is recorded under: web pages only, without the fragment, so
 * jumping between sections of one page is one entry.
 */
export const historyUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.href.length > MAX_URL_LENGTH ? null : url.href;
  } catch {
    return null;
  }
};

/**
 * Folds imported entries into existing history without double counting a
 * repeated import: each field keeps the larger value, and a real title wins
 * over the URL placeholder.
 */
export const mergeHistoryEntry = (
  existing: HistoryEntry | undefined,
  incoming: HistoryEntry,
): HistoryEntry => {
  if (existing === undefined) {
    return incoming;
  }
  return {
    url: existing.url,
    title: existing.title === existing.url ? incoming.title : existing.title,
    visitCount: Math.max(existing.visitCount, incoming.visitCount),
    lastVisit: Math.max(existing.lastVisit, incoming.lastVisit),
  };
};

export class BrowsingHistory extends Context.Service<
  BrowsingHistory,
  {
    readonly search: (input: {
      readonly text: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<HistoryEntry>, BrowsingHistoryError>;
    readonly importEntries: (
      entries: ReadonlyArray<HistoryEntry>,
    ) => Effect.Effect<{ readonly imported: number }, BrowsingHistoryError>;
    /** Records the guest's visits and titles; returns the detach function. */
    readonly attachGuest: (guest: WebContents) => () => void;
    /** Forgets every visited page. */
    readonly clear: Effect.Effect<void, BrowsingHistoryError>;
  }
>()("@t3tools/desktop/preview/History/BrowsingHistory") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // The connection lives as long as the service, not the first caller.
  const serviceScope = yield* Scope.Scope;
  const filename = path.join(environment.stateDir, "preview-history.sqlite");

  // Opened on first use, so a browser nobody opens never creates the file.
  const database = yield* Effect.cached(
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
      const sql = Context.get(context, SqlClient.SqlClient);
      yield* sql`create table if not exists places (
        url text primary key,
        title text not null,
        visit_count integer not null,
        last_visit integer not null
      )`;
      // Visited URLs can carry sign-in links and tokens; only the user reads them.
      yield* fileSystem.chmod(filename, 0o600);
      return sql;
    }).pipe(
      Effect.provideService(Scope.Scope, serviceScope),
      Effect.mapError((cause) => new BrowsingHistoryError({ operation: "open", cause })),
    ),
  );

  // Min keeps the whole history in memory: it is small, and every keystroke
  // in the address bar searches it.
  const cache = yield* SynchronizedRef.make<Map<string, HistoryEntry> | undefined>(undefined);

  const loaded = SynchronizedRef.modifyEffect(cache, (current) =>
    current !== undefined
      ? Effect.succeed([current, current] as const)
      : Effect.gen(function* () {
          const sql = yield* database;
          const cutoff = (yield* Clock.currentTimeMillis) - HISTORY_MAX_AGE_MS;
          const rows = yield* sql`delete from places where last_visit < ${cutoff}`.pipe(
            Effect.andThen(sql`select url, title, visit_count, last_visit from places`),
            Effect.flatMap(decodePlaceRows),
            Effect.mapError((cause) => new BrowsingHistoryError({ operation: "read", cause })),
          );
          const entries = new Map(
            rows.map(
              (row) =>
                [
                  row.url,
                  {
                    url: row.url,
                    title: row.title,
                    visitCount: row.visit_count,
                    lastVisit: row.last_visit,
                  },
                ] as const,
            ),
          );
          return [entries, entries] as const;
        }),
  );

  const writeEntries = Effect.fn("BrowsingHistory.writeEntries")(function* (
    entries: ReadonlyArray<HistoryEntry>,
  ) {
    const sql = yield* database;
    yield* sql
      .withTransaction(
        Effect.forEach(
          entries,
          (entry) =>
            sql`insert into places (url, title, visit_count, last_visit)
              values (${entry.url}, ${entry.title}, ${entry.visitCount}, ${entry.lastVisit})
              on conflict (url) do update set title = excluded.title,
                visit_count = excluded.visit_count, last_visit = excluded.last_visit`,
          { discard: true },
        ),
      )
      .pipe(Effect.mapError((cause) => new BrowsingHistoryError({ operation: "write", cause })));
  });

  /** Applies `change` to the cached entries and writes the ones it returns. */
  const update = (
    change: (entries: Map<string, HistoryEntry>, now: number) => ReadonlyArray<HistoryEntry>,
  ) =>
    Effect.gen(function* () {
      yield* loaded;
      const now = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modifyEffect(cache, (current) =>
        Effect.gen(function* () {
          const entries = new Map(current);
          const changed = change(entries, now);
          if (changed.length > 0) {
            yield* writeEntries(changed);
          }
          return [changed.length, entries] as const;
        }),
      );
    });

  const recordVisit = (rawUrl: string) =>
    update((entries, now) => {
      const url = historyUrl(rawUrl);
      if (url === null) {
        return [];
      }
      const existing = entries.get(url);
      const entry = {
        url,
        title: existing?.title ?? url,
        visitCount: (existing?.visitCount ?? 0) + 1,
        lastVisit: now,
      };
      entries.set(url, entry);
      return [entry];
    });

  const recordTitle = ({ rawUrl, title }: { readonly rawUrl: string; readonly title: string }) =>
    update((entries) => {
      const url = historyUrl(rawUrl);
      const existing = url === null ? undefined : entries.get(url);
      const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
      if (existing === undefined || trimmed === "" || existing.title === trimmed) {
        return [];
      }
      const entry = { ...existing, title: trimmed };
      entries.set(existing.url, entry);
      return [entry];
    });

  const importEntries = (incoming: ReadonlyArray<HistoryEntry>) =>
    update((entries, now) => {
      const changed: HistoryEntry[] = [];
      for (const raw of incoming) {
        const url = historyUrl(raw.url);
        if (url === null || raw.lastVisit < now - HISTORY_MAX_AGE_MS) {
          continue;
        }
        const entry = mergeHistoryEntry(entries.get(url), {
          ...raw,
          url,
          title: raw.title.trim().slice(0, MAX_TITLE_LENGTH) || url,
        });
        entries.set(url, entry);
        changed.push(entry);
      }
      return changed;
    }).pipe(Effect.map((imported) => ({ imported })));

  const search = ({ text, limit }: { readonly text: string; readonly limit: number }) =>
    loaded.pipe(
      Effect.map((entries) => searchHistory({ entries: [...entries.values()], text, limit })),
    );

  const record = <E>(effect: Effect.Effect<unknown, E>) =>
    runFork(
      effect.pipe(
        Effect.catch((error) => Effect.logWarning("Browsing history update failed", { error })),
      ),
    );

  const attachGuest = (guest: WebContents) => {
    // Private sessions keep nothing, so they leave no history either.
    if (!guest.session.isPersistent()) {
      return () => {};
    }

    let lastRecorded: string | null = null;
    const visit = (url: string) => {
      const normalized = historyUrl(url);
      if (normalized === null || normalized === lastRecorded) {
        return;
      }
      lastRecorded = normalized;
      record(recordVisit(url));
    };
    const navigated = (_event: unknown, url: string, httpResponseCode: number) => {
      // Error pages are not places worth suggesting again.
      if (httpResponseCode < 400) {
        lastRecorded = null;
        visit(url);
      }
    };
    // Single-page apps change pages without a full navigation.
    const navigatedInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) {
        visit(url);
      }
    };
    const titleUpdated = (_event: unknown, title: string) => {
      record(recordTitle({ rawUrl: guest.getURL(), title }));
    };

    guest.on("did-navigate", navigated);
    guest.on("did-navigate-in-page", navigatedInPage);
    guest.on("page-title-updated", titleUpdated);
    return () => {
      guest.off("did-navigate", navigated);
      guest.off("did-navigate-in-page", navigatedInPage);
      guest.off("page-title-updated", titleUpdated);
    };
  };

  const clear = SynchronizedRef.updateEffect(cache, () =>
    Effect.gen(function* () {
      const sql = yield* database;
      yield* sql`delete from places`.pipe(
        Effect.mapError((cause) => new BrowsingHistoryError({ operation: "clear", cause })),
      );
      return new Map<string, HistoryEntry>();
    }),
  ).pipe(Effect.withSpan("BrowsingHistory.clear"));

  return BrowsingHistory.of({ search, importEntries, attachGuest, clear });
});

export const layer = Layer.effect(BrowsingHistory, make);
