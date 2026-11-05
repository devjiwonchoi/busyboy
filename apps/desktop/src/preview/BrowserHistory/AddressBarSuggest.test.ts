// @effect-diagnostics nodeBuiltinImport:off - Tests use temp-dir node:sqlite files.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { frequentFromHistory, suggestFromHistory } from "./AddressBarSuggest.ts";
import { HistoryDatabase, type NewVisit } from "./HistoryDatabase.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openDatabase() {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-suggest-"));
  const db = HistoryDatabase.open(NodePath.join(directory, "history.sqlite"));
  cleanups.push(() => {
    db.close();
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
  const add = (url: string, overrides: Partial<NewVisit> = {}, times = 1) => {
    for (let index = 0; index < times; index += 1) {
      db.recordVisit({
        url,
        visitedAt: NOW - DAY - index,
        transition: "link",
        source: "user",
        ...overrides,
      });
    }
  };
  return { db, add };
}

describe("suggestFromHistory", () => {
  it("matches every term in the URL or title and ranks by frecency", () => {
    const { db, add } = openDatabase();
    add("https://docs.example.com/guide", { title: "Rust guide" });
    add("https://example.com/rust/book", { transition: "typed" }, 3);
    add("https://other.test/", { title: "Unrelated" });

    const result = suggestFromHistory(db, { text: "rust EXAMPLE", now: NOW, limit: 8 });
    expect(result.matches.map((match) => match.url)).toEqual([
      "https://example.com/rust/book",
      "https://docs.example.com/guide",
    ]);
  });

  it("boosts host prefixes and reports the top match's origin for inline completion", () => {
    const { db, add } = openDatabase();
    add("https://news.example/github-story", {}, 2);
    add("https://github.com/org/repo");
    add("https://github.com/", {}, 2);

    const result = suggestFromHistory(db, { text: "git", now: NOW, limit: 8 });
    expect(result.matches[0]?.url.startsWith("https://github.com/")).toBe(true);
    expect(result.topOrigin).toEqual({ url: "https://github.com/", visitCount: 2 });
  });

  it("leaves out hidden redirect hops and returns nothing for empty input", () => {
    const { db, add } = openDatabase();
    add("https://hop.example/", { transition: "redirect" });
    expect(suggestFromHistory(db, { text: "hop", now: NOW, limit: 8 }).matches).toEqual([]);
    expect(suggestFromHistory(db, { text: "  ", now: NOW, limit: 8 })).toEqual({
      matches: [],
      topOrigin: null,
    });
  });

  it("answers within 50 ms p95 for a 20k-URL history", () => {
    const { db } = openDatabase();
    for (let index = 0; index < 20_000; index += 1) {
      db.recordVisit({
        url: `https://site${index % 2_000}.example/page/${index}`,
        title: `Page ${index}`,
        visitedAt: NOW - (index % 80) * DAY,
        transition: index % 3 === 0 ? "typed" : "link",
        source: "user",
      });
    }
    // Best of three per keystroke, then p95 across keystrokes: this measures the
    // query's own cost, not whatever else a busy CI machine is doing.
    const durations: number[] = [];
    for (const text of ["s", "si", "sit", "site", "site1", "site12", "page", "page 1", "e", "x"]) {
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now();
        suggestFromHistory(db, { text, now: NOW, limit: 8 });
        best = Math.min(best, performance.now() - started);
      }
      durations.push(best);
    }
    const sorted = durations.toSorted((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(50);
    // Seeding 20k visits is slow on a loaded machine; only the queries are timed.
  }, 120_000);
});

describe("frequentFromHistory", () => {
  it("lists the best-ranked sites a person visited and skips agent-only ones", () => {
    const { db, add } = openDatabase();
    add("https://daily.example/", { transition: "typed" }, 5);
    add("https://sometimes.example/", {}, 2);
    add("https://agent-only.example/", { transition: "agent", source: "agent" }, 10);
    add("https://stale.example/", { visitedAt: NOW - 91 * DAY }, 10);

    expect(frequentFromHistory(db, { now: NOW, limit: 6 }).map((site) => site.url)).toEqual([
      "https://daily.example/",
      "https://sometimes.example/",
    ]);
  });
});
