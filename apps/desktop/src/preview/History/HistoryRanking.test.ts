import { describe, expect, it } from "@effect/vitest";

import { formatSearchUrl, historyScore, searchHistory } from "./HistoryRanking.ts";

const now = Date.UTC(2026, 9, 27);
const entry = (url: string, title: string, visitCount: number, daysAgo: number) => ({
  url,
  title,
  visitCount,
  lastVisit: now - daysAgo * 24 * 60 * 60 * 1000,
});

describe("formatSearchUrl", () => {
  it("drops the scheme, www, query and separators", () => {
    expect(formatSearchUrl("https://www.Example.com/Docs/getting-started?x=1")).toBe(
      "example com docs getting started",
    );
  });
});

describe("historyScore", () => {
  it("favours recent visits, then frequent ones", () => {
    const recent = entry("https://example.com/a-long-path", "A", 1, 0);
    const old = entry("https://example.com/a-long-path", "A", 1, 10);
    const frequent = entry("https://example.com/a-long-path", "A", 50, 0);
    expect(historyScore(recent, 0)).toBeGreaterThan(historyScore(old, 0));
    expect(historyScore(frequent, 0)).toBeGreaterThan(historyScore(recent, 0));
  });
});

describe("searchHistory", () => {
  const entries = [
    entry("https://news.ycombinator.com/item?id=1", "Show HN: GitHub clone", 1, 0),
    entry("https://github.com/devjiwonchoi/busyboy/pulls", "Pull requests", 3, 1),
    entry("https://docs.github.com/en", "GitHub Docs", 1, 0),
    entry("https://example.com/", "Example Domain", 5, 0),
  ];
  const urls = (text: string) =>
    searchHistory({ entries, text, limit: 10 }).map((match) => match.url);

  it("ranks a match at the start of the URL above matches elsewhere", () => {
    expect(urls("github")[0]).toBe("https://github.com/devjiwonchoi/busyboy/pulls");
    expect(urls("github")).toContain("https://docs.github.com/en");
  });

  it("matches titles and every word in any order when the text has spaces", () => {
    expect(urls("busyboy pulls")).toEqual(["https://github.com/devjiwonchoi/busyboy/pulls"]);
    expect(urls("domain")).toEqual(["https://example.com/"]);
  });

  it("returns nothing for empty text and respects the limit", () => {
    expect(urls("  ")).toEqual([]);
    expect(searchHistory({ entries, text: "github", limit: 1 })).toHaveLength(1);
  });
});
