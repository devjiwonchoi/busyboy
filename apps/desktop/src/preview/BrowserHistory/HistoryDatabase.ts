// @effect-diagnostics nodeBuiltinImport:off - The history store is a synchronous node:sqlite database.
import type {
  BrowserHistoryCursor,
  BrowserHistoryRecentEntry,
  BrowserHistorySource,
  BrowserHistorySourceFilter,
  BrowserHistoryTransition,
  BrowserHistoryVisit,
} from "@t3tools/contracts";
import { BROWSER_HISTORY_RETENTION_DAYS } from "@t3tools/contracts";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { normalizeHistoryTitle, normalizeHistoryUrl } from "./HistoryUrl.ts";

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_RETENTION_MS = BROWSER_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface NewVisit {
  readonly url: string;
  readonly title?: string | null | undefined;
  readonly visitedAt: number;
  readonly transition: BrowserHistoryTransition;
  readonly source: BrowserHistorySource;
  readonly threadId?: string | null | undefined;
}

export interface SearchOptions {
  readonly query?: string | undefined;
  readonly source?: BrowserHistorySourceFilter | undefined;
  readonly before?: BrowserHistoryCursor | undefined;
  readonly limit: number;
}

export interface SearchPage {
  readonly visits: ReadonlyArray<BrowserHistoryVisit>;
  readonly nextCursor: BrowserHistoryCursor | null;
}

export interface UrlAggregate {
  readonly url: string;
  readonly title: string | null;
  readonly visitCount: number;
  readonly typedCount: number;
  readonly lastVisitedAt: number;
  readonly hidden: boolean;
}

/** Each step brings the schema from version `index` to `index + 1`. Never edit a shipped step. */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE urls (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    visit_count INTEGER NOT NULL DEFAULT 0,
    typed_count INTEGER NOT NULL DEFAULT 0,
    last_visited_at INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE visits (
    id INTEGER PRIMARY KEY,
    url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
    visited_at INTEGER NOT NULL,
    transition TEXT NOT NULL,
    source TEXT NOT NULL,
    thread_id TEXT
  );
  CREATE INDEX visits_visited_at ON visits(visited_at);
  CREATE INDEX visits_url_id ON visits(url_id);
  CREATE INDEX urls_last_visited_at ON urls(last_visited_at);
  `,
];

const TYPED_TRANSITIONS = "('typed','suggestion')";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

interface VisitRow {
  readonly id: number;
  readonly url: string;
  readonly title: string | null;
  readonly visited_at: number;
  readonly transition: BrowserHistoryTransition;
  readonly source: BrowserHistorySource;
  readonly thread_id: string | null;
}

/**
 * One profile's browsing history. Synchronous by design: every statement is a
 * few indexed rows, and callers keep writes off the navigation path.
 */
export class HistoryDatabase {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(filename: string): HistoryDatabase {
    const db = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 2000");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      const current = row === undefined ? 0 : Number(row.value);
      if (!Number.isInteger(current) || current > HISTORY_SCHEMA_VERSION) {
        throw new Error(`Unsupported browser history schema version ${row?.value}.`);
      }
      for (let version = current; version < HISTORY_SCHEMA_VERSION; version += 1) {
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
      return new HistoryDatabase(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private transaction<A>(body: () => A): A {
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

  /** Returns the new visit id, or null when the URL is not something history keeps. */
  recordVisit(visit: NewVisit): number | null {
    const url = normalizeHistoryUrl(visit.url);
    if (url === null) return null;
    return this.transaction(() => this.insertVisit(url, visit));
  }

  private insertVisit(url: string, visit: NewVisit): number {
    const title = normalizeHistoryTitle(visit.title);
    const typed = visit.transition === "typed" || visit.transition === "suggestion" ? 1 : 0;
    // A URL is hidden only while every visit to it was a redirect hop.
    const hidden = visit.transition === "redirect" ? 1 : 0;
    const urlRow = this.db
      .prepare(
        `INSERT INTO urls (url, title, visit_count, typed_count, last_visited_at, hidden)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = COALESCE(excluded.title, urls.title),
           visit_count = urls.visit_count + 1,
           typed_count = urls.typed_count + excluded.typed_count,
           last_visited_at = MAX(urls.last_visited_at, excluded.last_visited_at),
           hidden = urls.hidden AND excluded.hidden
         RETURNING id`,
      )
      .get(url, title, typed, visit.visitedAt, hidden) as { id: number };
    const result = this.db
      .prepare(
        "INSERT INTO visits (url_id, visited_at, transition, source, thread_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(urlRow.id, visit.visitedAt, visit.transition, visit.source, visit.threadId ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Titles arrive after the commit; they belong to the URL, not a single visit. */
  setTitle(rawUrl: string, rawTitle: string): boolean {
    const url = normalizeHistoryUrl(rawUrl);
    const title = normalizeHistoryTitle(rawTitle);
    if (url === null || title === null) return false;
    const result = this.db
      .prepare("UPDATE urls SET title = ? WHERE url = ? AND (title IS NULL OR title <> ?)")
      .run(title, url, title);
    return result.changes > 0;
  }

  search(options: SearchOptions): SearchPage {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const terms = (options.query ?? "").trim();
    if (terms.length > 0) {
      const pattern = `%${escapeLike(terms)}%`;
      where.push("(u.url LIKE ? ESCAPE '\\' OR IFNULL(u.title, '') LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (options.source === "user" || options.source === "agent") {
      where.push("v.source = ?");
      params.push(options.source);
    }
    if (options.before !== undefined) {
      where.push("(v.visited_at < ? OR (v.visited_at = ? AND v.id < ?))");
      params.push(options.before.visitedAt, options.before.visitedAt, options.before.id);
    }
    const rows = this.db
      .prepare(
        `SELECT v.id, u.url, u.title, v.visited_at, v.transition, v.source, v.thread_id
         FROM visits v JOIN urls u ON u.id = v.url_id
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY v.visited_at DESC, v.id DESC
         LIMIT ?`,
      )
      .all(...params, options.limit + 1) as unknown as VisitRow[];
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      visits: page.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title,
        visitedAt: row.visited_at,
        transition: row.transition,
        source: row.source,
        threadId: row.thread_id,
      })),
      nextCursor:
        rows.length > options.limit && last !== undefined
          ? { visitedAt: last.visited_at, id: last.id }
          : null,
    };
  }

  /** Distinct, non-hidden URLs, most recently visited first. */
  recent(limit: number): ReadonlyArray<BrowserHistoryRecentEntry> {
    const rows = this.db
      .prepare(
        "SELECT url, title, last_visited_at FROM urls WHERE hidden = 0 ORDER BY last_visited_at DESC, id DESC LIMIT ?",
      )
      .all(limit) as unknown as Array<{
      url: string;
      title: string | null;
      last_visited_at: number;
    }>;
    return rows.map((row) => ({
      url: row.url,
      title: row.title,
      lastVisitedAt: row.last_visited_at,
    }));
  }

  /** Aggregates for one URL, mainly for tests and suggestion ranking. */
  aggregate(rawUrl: string): UrlAggregate | null {
    const url = normalizeHistoryUrl(rawUrl);
    if (url === null) return null;
    const row = this.db
      .prepare(
        "SELECT url, title, visit_count, typed_count, last_visited_at, hidden FROM urls WHERE url = ?",
      )
      .get(url) as
      | {
          url: string;
          title: string | null;
          visit_count: number;
          typed_count: number;
          last_visited_at: number;
          hidden: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          url: row.url,
          title: row.title,
          visitCount: row.visit_count,
          typedCount: row.typed_count,
          lastVisitedAt: row.last_visited_at,
          hidden: row.hidden === 1,
        };
  }

  visitCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM visits").get() as { n: number }).n;
  }

  /** Returns the number of visits removed. */
  remove(input: {
    readonly visitIds?: ReadonlyArray<number> | undefined;
    readonly urls?: ReadonlyArray<string> | undefined;
  }): number {
    const urls = (input.urls ?? []).flatMap((raw) => {
      const url = normalizeHistoryUrl(raw);
      return url === null ? [] : [url];
    });
    const visitIds = input.visitIds ?? [];
    if (urls.length === 0 && visitIds.length === 0) return 0;
    return this.transaction(() => {
      let removed = 0;
      const deleteVisit = this.db.prepare("DELETE FROM visits WHERE id = ?");
      for (const id of visitIds) removed += Number(deleteVisit.run(id).changes);
      const deleteUrlVisits = this.db.prepare(
        "DELETE FROM visits WHERE url_id = (SELECT id FROM urls WHERE url = ?)",
      );
      const deleteUrl = this.db.prepare("DELETE FROM urls WHERE url = ?");
      for (const url of urls) {
        removed += Number(deleteUrlVisits.run(url).changes);
        deleteUrl.run(url);
      }
      this.recomputeAggregates();
      return removed;
    });
  }

  /** Deletes visits at or after `since` (all visits when null). Returns the number removed. */
  clearSince(since: number | null): number {
    return this.transaction(() => {
      const result =
        since === null
          ? this.db.prepare("DELETE FROM visits").run()
          : this.db.prepare("DELETE FROM visits WHERE visited_at >= ?").run(since);
      this.recomputeAggregates();
      return Number(result.changes);
    });
  }

  /** Drops visits older than the retention window. Returns the number removed. */
  prune(now: number): number {
    return this.transaction(() => {
      const result = this.db
        .prepare("DELETE FROM visits WHERE visited_at < ?")
        .run(now - HISTORY_RETENTION_MS);
      if (Number(result.changes) > 0) this.recomputeAggregates();
      return Number(result.changes);
    });
  }

  /**
   * Imports one typed visit per entry. An entry whose URL already has a visit at
   * the same time is skipped, so running the import twice adds nothing. Entries
   * before `notBefore` (outside retention) are dropped.
   */
  importLegacy(
    entries: ReadonlyArray<{
      readonly url: string;
      readonly title?: string | undefined;
      readonly lastVisitedAt: number;
    }>,
    notBefore = Number.NEGATIVE_INFINITY,
  ): number {
    const latest = new Map<string, { title: string | undefined; at: number }>();
    for (const entry of entries) {
      const url = normalizeHistoryUrl(entry.url);
      if (url === null || !Number.isFinite(entry.lastVisitedAt)) continue;
      if (entry.lastVisitedAt < notBefore) continue;
      const existing = latest.get(url);
      if (existing === undefined || entry.lastVisitedAt > existing.at) {
        latest.set(url, { title: entry.title ?? existing?.title, at: entry.lastVisitedAt });
      } else if (existing.title === undefined && entry.title !== undefined) {
        existing.title = entry.title;
      }
    }
    return this.transaction(() => {
      const exists = this.db.prepare(
        "SELECT 1 FROM visits v JOIN urls u ON u.id = v.url_id WHERE u.url = ? AND v.visited_at = ? LIMIT 1",
      );
      let imported = 0;
      for (const [url, { title, at }] of latest) {
        if (exists.get(url, Math.trunc(at)) !== undefined) continue;
        this.insertVisit(url, {
          url,
          title,
          visitedAt: Math.trunc(at),
          transition: "typed",
          source: "user",
        });
        imported += 1;
      }
      return imported;
    });
  }

  private recomputeAggregates(): void {
    this.db.exec("DELETE FROM urls WHERE NOT EXISTS (SELECT 1 FROM visits WHERE url_id = urls.id)");
    this.db.exec(`
      UPDATE urls SET
        visit_count = (SELECT COUNT(*) FROM visits WHERE url_id = urls.id),
        typed_count = (SELECT COUNT(*) FROM visits WHERE url_id = urls.id AND transition IN ${TYPED_TRANSITIONS}),
        last_visited_at = (SELECT MAX(visited_at) FROM visits WHERE url_id = urls.id),
        hidden = NOT EXISTS (SELECT 1 FROM visits WHERE url_id = urls.id AND transition <> 'redirect')
    `);
  }
}
