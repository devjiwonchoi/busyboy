import { describe, expect, it } from "@effect/vitest";

import { frecencyScore, typedPrefixesHost, type FrecencyVisit } from "./Frecency.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4);

const visits = (
  count: number,
  daysAgo: number,
  transition: FrecencyVisit["transition"],
  source: FrecencyVisit["source"] = "user",
): FrecencyVisit[] =>
  Array.from({ length: count }, (_, index) => ({
    visitedAt: NOW - daysAgo * DAY - index,
    transition,
    source,
  }));

describe("frecencyScore", () => {
  it("ranks a typed URL above a link-visited one with the same counts", () => {
    const typed = frecencyScore({ visits: visits(3, 1, "typed"), typedCount: 3, now: NOW });
    const linked = frecencyScore({ visits: visits(3, 1, "link"), typedCount: 0, now: NOW });
    expect(typed).toBeGreaterThan(linked);
  });

  it("lets a few recent visits beat many visits from two months ago", () => {
    const recent = frecencyScore({ visits: visits(3, 1, "link"), typedCount: 0, now: NOW });
    const old = frecencyScore({ visits: visits(30, 60, "link"), typedCount: 0, now: NOW });
    expect(recent).toBeGreaterThan(old * 1.25);
  });

  it("ranks agent-only visits below user visits", () => {
    const user = frecencyScore({ visits: visits(3, 1, "link"), typedCount: 0, now: NOW });
    const agent = frecencyScore({
      visits: visits(3, 1, "link", "agent"),
      typedCount: 0,
      now: NOW,
    });
    expect(agent).toBeLessThan(user);
  });

  it("drops visits past 90 days and boosts host prefixes", () => {
    expect(frecencyScore({ visits: visits(5, 91, "typed"), typedCount: 5, now: NOW })).toBe(0);
    const plain = frecencyScore({ visits: visits(1, 1, "link"), typedCount: 0, now: NOW });
    const boosted = frecencyScore({
      visits: visits(1, 1, "link"),
      typedCount: 0,
      now: NOW,
      hostPrefixMatch: true,
    });
    expect(boosted).toBe(plain * 1.5);
  });

  it("detects a typed host prefix ignoring scheme and www", () => {
    expect(typedPrefixesHost("git", "https://www.github.com/x")).toBe(true);
    expect(typedPrefixesHost("https://www.git", "https://github.com/")).toBe(true);
    expect(typedPrefixesHost("127.0.0.1:4000/we", "http://127.0.0.1:4000/welcome")).toBe(true);
    expect(typedPrefixesHost("hub", "https://github.com/")).toBe(false);
  });
});
