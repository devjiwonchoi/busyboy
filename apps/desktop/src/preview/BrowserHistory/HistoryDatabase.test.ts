// @effect-diagnostics nodeBuiltinImport:off - Tests use temp-dir node:sqlite files.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { HISTORY_RETENTION_MS, HistoryDatabase, type NewVisit } from "./HistoryDatabase.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);

const directories: string[] = [];
const databases: HistoryDatabase[] = [];

function openDatabase(): { db: HistoryDatabase; filename: string } {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-history-db-"));
  directories.push(directory);
  const filename = NodePath.join(directory, "history.sqlite");
  const db = HistoryDatabase.open(filename);
  databases.push(db);
  return { db, filename };
}

const visit = (overrides: Partial<NewVisit> & Pick<NewVisit, "url">): NewVisit => ({
  visitedAt: NOW,
  transition: "link",
  source: "user",
  ...overrides,
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    NodeFs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("HistoryDatabase", () => {
  it("records visits and keeps per-URL aggregates", () => {
    const { db } = openDatabase();
    db.recordVisit(
      visit({ url: "https://example.com/a", transition: "typed", visitedAt: NOW - 2 }),
    );
    db.recordVisit(visit({ url: "https://example.com/a", visitedAt: NOW - 1, title: "Page A" }));
    db.recordVisit(
      visit({ url: "https://example.com/a", transition: "suggestion", visitedAt: NOW }),
    );

    expect(db.aggregate("https://example.com/a")).toEqual({
      url: "https://example.com/a",
      title: "Page A",
      visitCount: 3,
      typedCount: 2,
      lastVisitedAt: NOW,
      hidden: false,
    });
    expect(db.visitCount()).toBe(3);
  });

  it("strips credentials and fragments, and skips URLs history does not keep", () => {
    const { db } = openDatabase();
    db.recordVisit(visit({ url: "https://user:secret@example.com/a#section" }));
    for (const url of [
      "about:blank",
      "data:text/html,hi",
      "blob:https://example.com/1",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://example.com",
      "javascript:alert(1)",
      "file:///etc/hosts",
      `https://example.com/${"x".repeat(2100)}`,
    ]) {
      expect(db.recordVisit(visit({ url }))).toBeNull();
    }

    const { visits } = db.search({ limit: 10 });
    expect(visits.map((entry) => entry.url)).toEqual(["https://example.com/a"]);
  });

  it("records loopback dev servers", () => {
    const { db } = openDatabase();
    db.recordVisit(visit({ url: "http://127.0.0.1:5173/" }));
    db.recordVisit(visit({ url: "http://localhost:3000/welcome", visitedAt: NOW + 1 }));
    expect(db.recent(8).map((entry) => entry.url)).toEqual([
      "http://localhost:3000/welcome",
      "http://127.0.0.1:5173/",
    ]);
  });

  it("searches url and title case-insensitively, filters by source, and paginates newest first", () => {
    const { db } = openDatabase();
    db.recordVisit(
      visit({ url: "https://docs.example.com/", title: "Welcome Docs", visitedAt: 1 }),
    );
    db.recordVisit(visit({ url: "https://example.com/welcome", visitedAt: 2 }));
    db.recordVisit(
      visit({
        url: "http://127.0.0.1:4000/welcome",
        visitedAt: 3,
        transition: "agent",
        source: "agent",
        threadId: "thread-1",
      }),
    );
    db.recordVisit(visit({ url: "https://other.test/", visitedAt: 4 }));

    const first = db.search({ query: "WELCOME", limit: 2 });
    expect(first.visits.map((entry) => entry.visitedAt)).toEqual([3, 2]);
    expect(first.nextCursor).not.toBeNull();
    const second = db.search({ query: "welcome", limit: 2, before: first.nextCursor! });
    expect(second.visits.map((entry) => entry.url)).toEqual(["https://docs.example.com/"]);
    expect(second.nextCursor).toBeNull();

    const agent = db.search({ source: "agent", limit: 10 });
    expect(agent.visits).toEqual([
      expect.objectContaining({ source: "agent", transition: "agent", threadId: "thread-1" }),
    ]);
    expect(db.search({ source: "user", limit: 10 }).visits).toHaveLength(3);
    // LIKE wildcards in the query are literal.
    expect(db.search({ query: "%", limit: 10 }).visits).toHaveLength(0);
  });

  it("removes single visits and whole URLs, then recomputes aggregates", () => {
    const { db } = openDatabase();
    const firstVisit = db.recordVisit(
      visit({ url: "https://a.test/", transition: "typed", visitedAt: 1 }),
    );
    db.recordVisit(visit({ url: "https://a.test/", visitedAt: 2 }));
    db.recordVisit(visit({ url: "https://b.test/", visitedAt: 3 }));

    db.remove({ visitIds: [firstVisit!] });
    expect(db.aggregate("https://a.test/")).toMatchObject({
      visitCount: 1,
      typedCount: 0,
      lastVisitedAt: 2,
    });

    db.remove({ urls: ["https://b.test/#anything"] });
    expect(db.aggregate("https://b.test/")).toBeNull();
    expect(db.recent(8).map((entry) => entry.url)).toEqual(["https://a.test/"]);
  });

  it("clears visits since a cutoff and keeps older ones", () => {
    const { db } = openDatabase();
    db.recordVisit(visit({ url: "https://old.test/", visitedAt: NOW - 2 * DAY }));
    db.recordVisit(visit({ url: "https://recent.test/", visitedAt: NOW - 1_000 }));
    db.recordVisit(visit({ url: "https://old.test/", visitedAt: NOW - 500 }));

    expect(db.clearSince(NOW - 60 * 60 * 1000)).toBe(2);
    expect(db.aggregate("https://recent.test/")).toBeNull();
    expect(db.aggregate("https://old.test/")).toMatchObject({
      visitCount: 1,
      lastVisitedAt: NOW - 2 * DAY,
    });
    expect(db.clearSince(null)).toBe(1);
    expect(db.visitCount()).toBe(0);
  });

  it("prunes visits older than 90 days", () => {
    const { db } = openDatabase();
    db.recordVisit(visit({ url: "https://stale.test/", visitedAt: NOW - 91 * DAY }));
    db.recordVisit(visit({ url: "https://mixed.test/", visitedAt: NOW - 91 * DAY }));
    db.recordVisit(visit({ url: "https://mixed.test/", visitedAt: NOW - 10 * DAY }));

    expect(db.prune(NOW)).toBe(2);
    expect(db.aggregate("https://stale.test/")).toBeNull();
    expect(db.aggregate("https://mixed.test/")).toMatchObject({ visitCount: 1 });
    expect(HISTORY_RETENTION_MS).toBe(90 * DAY);
  });

  it("imports legacy entries once, deduped on URL with the latest timestamp", () => {
    const { db } = openDatabase();
    const entries = [
      { url: "https://a.test/", lastVisitedAt: NOW - 3 * DAY, title: "A old" },
      { url: "https://a.test/#frag", lastVisitedAt: NOW - DAY },
      { url: "https://b.test/", lastVisitedAt: NOW - 2 * DAY, title: "B" },
      { url: "not a url", lastVisitedAt: NOW },
    ];

    expect(db.importLegacy(entries)).toBe(2);
    expect(db.importLegacy(entries)).toBe(0);

    expect(db.aggregate("https://a.test/")).toMatchObject({
      visitCount: 1,
      typedCount: 1,
      lastVisitedAt: NOW - DAY,
      title: "A old",
    });
    const { visits } = db.search({ limit: 10 });
    expect(visits.every((entry) => entry.source === "user" && entry.transition === "typed")).toBe(
      true,
    );
  });

  it("updates titles after the visit and reopens an existing file", () => {
    const { db, filename } = openDatabase();
    db.recordVisit(visit({ url: "https://a.test/" }));
    expect(db.setTitle("https://a.test/#x", "  Hello  ")).toBe(true);
    expect(db.setTitle("https://a.test/", "Hello")).toBe(false);
    db.close();

    const reopened = HistoryDatabase.open(filename);
    databases.push(reopened);
    expect(reopened.aggregate("https://a.test/")?.title).toBe("Hello");
  });

  it("marks URLs reached only by redirect as hidden", () => {
    const { db } = openDatabase();
    db.recordVisit(visit({ url: "https://hop.test/", transition: "redirect" }));
    expect(db.aggregate("https://hop.test/")?.hidden).toBe(true);
    expect(db.recent(8)).toEqual([]);
    db.recordVisit(visit({ url: "https://hop.test/", visitedAt: NOW + 1 }));
    expect(db.aggregate("https://hop.test/")?.hidden).toBe(false);
  });
});
