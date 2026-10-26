// Adapted from Min (https://github.com/minbrowser/min), js/places/placesService.js,
// licensed under Apache-2.0.
// Modified for Busyboy: history lives in SQLite owned by the desktop main
// process instead of IndexedDB, records preview-tab navigations directly, and
// keeps no page text, tags or bookmarks.

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { WebContents } from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  HISTORY_MAX_AGE_MS,
  historyScore,
  indexHistoryEntry,
  searchHistory,
  type HistoryEntry,
  type IndexedHistoryEntry,
} from "./HistoryRanking.ts";

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
/** The most pages kept; past it the lowest-ranked ones go. */
export const HISTORY_MAX_ENTRIES = 10_000;
// Evicting a little extra means a full history is not sorted on every visit.
const EVICTION_SLACK = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// Stays under SQLite's limit on bound parameters.
const DELETE_CHUNK = 500;

const PlaceRow = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  visit_count: Schema.Number,
  last_visit: Schema.Number,
  typed: Schema.Number,
});
const decodePlaceRows = Schema.decodeUnknownEffect(Schema.Array(PlaceRow));
const ColumnRow = Schema.Struct({ name: Schema.String });
const decodeColumnRows = Schema.decodeUnknownEffect(Schema.Array(ColumnRow));

/**
 * Query parameters that tend to carry sign-in links, reset links, signed
 * URLs and API keys. Matched on the name lowercased with `-` and `_` removed.
 */
const SECRET_PARAMS = new Set([
  "auth",
  "code",
  "jwt",
  "key",
  "otp",
  "pass",
  "pwd",
  "saml",
  "samlrequest",
  "samlresponse",
  "sid",
  "sig",
  "ticket",
]);
const SECRET_PARAM_PARTS = [
  "accesskey",
  "apikey",
  "authorization",
  "credential",
  "oauth",
  "passwd",
  "password",
  "reset",
  "secret",
  "session",
  "signature",
  "token",
  "verifier",
];
const SECRET_PARAM_PREFIXES = ["xamz", "xgoog"];

export const isSecretParam = (name: string): boolean => {
  const key = name.toLowerCase().replace(/[-_.\s]/g, "");
  return (
    SECRET_PARAMS.has(key) ||
    SECRET_PARAM_PARTS.some((part) => key.includes(part)) ||
    SECRET_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
};

/**
 * The URL a visit is recorded under: web pages only, without the fragment, so
 * jumping between sections of one page is one entry, and without credentials
 * or query parameters that look secret.
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
    const params = Array.from(url.searchParams);
    const kept = params.filter(([name]) => !isSecretParam(name));
    if (kept.length !== params.length) {
      url.search = new URLSearchParams(kept).toString();
    }
    return url.href.length > MAX_URL_LENGTH ? null : url.href;
  } catch {
    return null;
  }
};

// Control and bidi characters can reorder or hide what the address bar shows.
const UNSAFE_TITLE_CHARACTERS =
  // oxlint-disable-next-line no-control-regex -- these are the characters it removes.
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export const cleanTitle = (title: string): string =>
  title.replace(UNSAFE_TITLE_CHARACTERS, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);

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
    typed: existing.typed || incoming.typed,
  };
};

export class BrowsingHistory extends Context.Service<
  BrowsingHistory,
  {
    readonly search: (input: {
      readonly text: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<HistoryEntry>, BrowsingHistoryError>;
    /** Changes on every clear; pass it to `importEntries` to drop a stale import. */
    readonly generation: Effect.Effect<number>;
    readonly importEntries: (
      entries: ReadonlyArray<HistoryEntry>,
      options?: { readonly generation?: number },
    ) => Effect.Effect<{ readonly imported: number }, BrowsingHistoryError>;
    /**
     * Records the guest's visits and titles, skipping navigations
     * `isAgentDriving` claims; returns the detach function.
     */
    readonly attachGuest: (
      guest: WebContents,
      options?: { readonly isAgentDriving?: () => boolean },
    ) => () => void;
    /** The guest's next page was typed or chosen in the address bar. */
    readonly markTyped: (guest: WebContents) => void;
    /** Forgets every visited page. */
    readonly clear: Effect.Effect<void, BrowsingHistoryError>;
  }
>()("@t3tools/desktop/preview/History/BrowsingHistory") {}

/** Where Chrome imports put their copy of Chrome's database. */
export const importCopiesDirectory = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  path: Path.Path,
): string => path.join(environment.stateDir, "preview-history-import");

interface State {
  readonly sql: SqlClient.SqlClient;
  /** Changed in place, only while the state ref is held. */
  readonly entries: Map<string, IndexedHistoryEntry>;
  readonly prunedAt: number;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // The connection lives as long as the service, not the first caller.
  const serviceScope = yield* Scope.Scope;
  const filename = path.join(environment.stateDir, "preview-history.sqlite");
  // An import interrupted by a crash leaves its copy of Chrome's history here.
  yield* fileSystem
    .remove(importCopiesDirectory(environment, path), { recursive: true })
    .pipe(Effect.ignore);

  /** Opened on first use, so a browser nobody opens never creates the file. */
  const open = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    // Visited URLs can carry sign-in links; the file is owner-only before
    // SQLite writes anything to it.
    yield* fileSystem.writeFile(filename, new Uint8Array(), { flag: "a", mode: 0o600 });
    yield* fileSystem.chmod(filename, 0o600);
    const scope = yield* Scope.fork(serviceScope, "sequential");
    return yield* Effect.gen(function* () {
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
      const sql = Context.get(context, SqlClient.SqlClient);
      // Deleted rows are overwritten, not just unlinked from the page.
      yield* sql`pragma secure_delete = on`;
      yield* sql`create table if not exists places (
        url text primary key,
        title text not null,
        visit_count integer not null,
        last_visit integer not null,
        typed integer not null default 0
      )`;
      const columns = yield* sql`pragma table_info(places)`.pipe(Effect.flatMap(decodeColumnRows));
      if (!columns.some((column) => column.name === "typed")) {
        yield* sql`alter table places add column typed integer not null default 0`;
      }
      return sql;
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      // A failed open is retried on the next use, not kept.
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  }).pipe(Effect.mapError((cause) => new BrowsingHistoryError({ operation: "open", cause })));

  const deleteUrls = (sql: SqlClient.SqlClient, urls: ReadonlyArray<string>) =>
    Effect.forEach(
      Array.from({ length: Math.ceil(urls.length / DELETE_CHUNK) }, (_, index) =>
        urls.slice(index * DELETE_CHUNK, (index + 1) * DELETE_CHUNK),
      ),
      (chunk) => sql`delete from places where url in ${sql.in(chunk)}`,
      { discard: true },
    );

  const prune = (state: State, now: number) =>
    Effect.gen(function* () {
      const cutoff = now - HISTORY_MAX_AGE_MS;
      yield* state.sql`delete from places where last_visit < ${cutoff}`;
      for (const [url, entry] of state.entries) {
        if (entry.lastVisit < cutoff) {
          state.entries.delete(url);
        }
      }
      return { ...state, prunedAt: now };
    }).pipe(Effect.mapError((cause) => new BrowsingHistoryError({ operation: "write", cause })));

  const load = Effect.gen(function* () {
    const sql = yield* open;
    const rows = yield* sql`select url, title, visit_count, last_visit, typed from places`.pipe(
      Effect.flatMap(decodePlaceRows),
      Effect.mapError((cause) => new BrowsingHistoryError({ operation: "read", cause })),
    );
    const entries = new Map<string, IndexedHistoryEntry>();
    for (const row of rows) {
      entries.set(
        row.url,
        indexHistoryEntry({
          url: row.url,
          title: row.title,
          visitCount: row.visit_count,
          lastVisit: row.last_visit,
          typed: row.typed !== 0,
        }),
      );
    }
    return yield* prune({ sql, entries, prunedAt: 0 }, yield* Clock.currentTimeMillis);
  });

  // Min keeps the whole history in memory: it is small, and every keystroke
  // in the address bar searches it.
  const stateRef = yield* SynchronizedRef.make<State | undefined>(undefined);

  /** Runs `use` with the loaded history, holding it so writes stay ordered. */
  const withState = <A>(
    use: (state: State, now: number) => Effect.Effect<A, BrowsingHistoryError>,
  ) =>
    SynchronizedRef.modifyEffect(stateRef, (current) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let state = current ?? (yield* load);
        if (now - state.prunedAt >= PRUNE_INTERVAL_MS) {
          state = yield* prune(state, now);
        }
        return [yield* use(state, now), state] as const;
      }),
    );

  // Bumped by clear. A write that started before a clear carries the old
  // value and is dropped, so cleared pages cannot come back.
  let generation = 0;

  /** Drops the lowest-ranked pages once the history is over its cap. */
  const evictOverflow = (state: State) =>
    Effect.gen(function* () {
      if (state.entries.size <= HISTORY_MAX_ENTRIES) {
        return;
      }
      const evicted = [...state.entries.values()]
        .toSorted((left, right) => historyScore(left, 0) - historyScore(right, 0))
        .slice(0, state.entries.size - HISTORY_MAX_ENTRIES + EVICTION_SLACK)
        .map((entry) => entry.url);
      yield* deleteUrls(state.sql, evicted);
      for (const url of evicted) {
        state.entries.delete(url);
      }
    });

  /** Writes what `change` returns and then applies it to the cache. */
  const update = (
    expectedGeneration: number,
    change: (
      entries: ReadonlyMap<string, IndexedHistoryEntry>,
      now: number,
    ) => ReadonlyArray<HistoryEntry>,
  ) =>
    withState((state, now) => {
      if (expectedGeneration !== generation) {
        return Effect.succeed(0);
      }
      const changed = change(state.entries, now);
      if (changed.length === 0) {
        return Effect.succeed(0);
      }
      const { sql } = state;
      return Effect.gen(function* () {
        yield* sql.withTransaction(
          Effect.forEach(
            changed,
            (entry) =>
              sql`insert into places (url, title, visit_count, last_visit, typed)
                values (${entry.url}, ${entry.title}, ${entry.visitCount},
                  ${entry.lastVisit}, ${entry.typed ? 1 : 0})
                on conflict (url) do update set title = excluded.title,
                  visit_count = excluded.visit_count, last_visit = excluded.last_visit,
                  typed = excluded.typed`,
            { discard: true },
          ),
        );
        // The cache follows the database only once the write landed.
        for (const entry of changed) {
          state.entries.set(entry.url, indexHistoryEntry(entry));
        }
        yield* evictOverflow(state);
        return changed.length;
      }).pipe(Effect.mapError((cause) => new BrowsingHistoryError({ operation: "write", cause })));
    });

  const recordVisit = ({
    url,
    typed,
    countVisit,
    expectedGeneration,
  }: {
    readonly url: string;
    readonly typed: boolean;
    readonly countVisit: boolean;
    readonly expectedGeneration: number;
  }) =>
    update(expectedGeneration, (entries, now) => {
      const existing = entries.get(url);
      if (!countVisit && (existing === undefined || existing.typed || !typed)) {
        return [];
      }
      return [
        {
          url,
          title: existing?.title ?? url,
          visitCount: (existing?.visitCount ?? 0) + (countVisit ? 1 : 0),
          lastVisit: countVisit ? now : (existing?.lastVisit ?? now),
          typed: typed || (existing?.typed ?? false),
        },
      ];
    });

  const recordTitle = ({
    rawUrl,
    title,
    expectedGeneration,
  }: {
    readonly rawUrl: string;
    readonly title: string;
    readonly expectedGeneration: number;
  }) =>
    update(expectedGeneration, (entries) => {
      const url = historyUrl(rawUrl);
      const existing = url === null ? undefined : entries.get(url);
      const cleaned = cleanTitle(title);
      if (existing === undefined || cleaned === "" || existing.title === cleaned) {
        return [];
      }
      return [{ ...existing, title: cleaned }];
    });

  const importEntries = (
    incoming: ReadonlyArray<HistoryEntry>,
    options?: { readonly generation?: number },
  ) =>
    update(options?.generation ?? generation, (entries, now) => {
      // Several Chrome profiles can hold the same page.
      const changed = new Map<string, HistoryEntry>();
      for (const raw of incoming) {
        const url = historyUrl(raw.url);
        if (url === null || raw.lastVisit < now - HISTORY_MAX_AGE_MS) {
          continue;
        }
        changed.set(
          url,
          mergeHistoryEntry(changed.get(url) ?? entries.get(url), {
            ...raw,
            url,
            title: cleanTitle(raw.title) || url,
          }),
        );
      }
      return [...changed.values()];
    }).pipe(Effect.map((imported) => ({ imported })));

  const search = ({ text, limit }: { readonly text: string; readonly limit: number }) =>
    withState((state, now) =>
      Effect.succeed(
        searchHistory({
          entries: state.entries.values(),
          text,
          limit,
          since: now - HISTORY_MAX_AGE_MS,
        }).map(({ searchText: _searchText, ...entry }) => entry),
      ),
    );

  const record = <E>(effect: Effect.Effect<unknown, E>) =>
    runFork(
      effect.pipe(
        Effect.catch((error) => Effect.logWarning("Browsing history update failed", { error })),
      ),
    );

  // Set by the preview manager just before it loads an address-bar URL.
  const typedGuests = new WeakSet<WebContents>();

  const attachGuest = (
    guest: WebContents,
    options?: { readonly isAgentDriving?: () => boolean },
  ) => {
    // Private sessions keep nothing, so they leave no history either.
    if (!guest.session.isPersistent()) {
      return () => {};
    }
    const isAgentDriving = options?.isAgentDriving ?? (() => false);

    let lastRecorded: string | null = null;
    let agentNavigation = false;
    const visit = (rawUrl: string, typed: boolean) => {
      const url = historyUrl(rawUrl);
      if (url === null) {
        return;
      }
      // A reload or a link back to the same page is not another visit.
      const countVisit = url !== lastRecorded;
      lastRecorded = url;
      if (countVisit || typed) {
        record(recordVisit({ url, typed, countVisit, expectedGeneration: generation }));
      }
    };
    const startedNavigation = (details: {
      readonly isMainFrame: boolean;
      readonly isSameDocument: boolean;
      readonly initiator?: unknown;
    }) => {
      if (!details.isMainFrame || details.isSameDocument) {
        return;
      }
      agentNavigation = isAgentDriving();
      // The page moved on by itself, so the next page is not the typed one.
      if (details.initiator) {
        typedGuests.delete(guest);
      }
    };
    const navigated = (_event: unknown, url: string, httpResponseCode: number) => {
      const typed = typedGuests.delete(guest);
      // Pages the agent opens are its work, not the user's history, and error
      // pages are not worth suggesting again.
      if (agentNavigation || isAgentDriving() || httpResponseCode >= 400) {
        return;
      }
      visit(url, typed);
    };
    // Single-page apps change pages without a full navigation.
    const navigatedInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame && !isAgentDriving()) {
        visit(url, false);
      }
    };
    const titleUpdated = (_event: unknown, title: string) => {
      record(recordTitle({ rawUrl: guest.getURL(), title, expectedGeneration: generation }));
    };

    guest.on("did-start-navigation", startedNavigation);
    guest.on("did-navigate", navigated);
    guest.on("did-navigate-in-page", navigatedInPage);
    guest.on("page-title-updated", titleUpdated);
    return () => {
      guest.off("did-start-navigation", startedNavigation);
      guest.off("did-navigate", navigated);
      guest.off("did-navigate-in-page", navigatedInPage);
      guest.off("page-title-updated", titleUpdated);
    };
  };

  const markTyped = (guest: WebContents) => {
    typedGuests.add(guest);
  };

  const clear = SynchronizedRef.updateEffect(stateRef, (current) =>
    Effect.gen(function* () {
      generation += 1;
      const sql = current?.sql ?? (yield* open);
      // VACUUM rewrites the file, so cleared URLs leave nothing on disk.
      yield* sql`delete from places`.pipe(
        Effect.andThen(sql`vacuum`),
        Effect.mapError((cause) => new BrowsingHistoryError({ operation: "clear", cause })),
      );
      return { sql, entries: new Map(), prunedAt: yield* Clock.currentTimeMillis };
    }),
  ).pipe(Effect.withSpan("BrowsingHistory.clear"));

  return BrowsingHistory.of({
    search,
    generation: Effect.sync(() => generation),
    importEntries,
    attachGuest,
    markTyped,
    clear,
  });
});

export const layer = Layer.effect(BrowsingHistory, make);
