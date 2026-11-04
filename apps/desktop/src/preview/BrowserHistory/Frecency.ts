import type { BrowserHistorySource, BrowserHistoryTransition } from "@t3tools/contracts";

/**
 * Address bar ranking: a URL scores by how recently and how deliberately it
 * was visited, in the spirit of the "frecency" idea browsers have long used.
 *
 *   score = Σ over its latest ≤ 10 visits of ageWeight(age) × transitionWeight
 *           × (1 + 0.5 × min(typedCount, 10) / 10)
 *           × 1.5 when the typed text is a prefix of the host
 *
 * Old visits fade quickly so a page used this week beats one that was used
 * heavily two months ago.
 */

const DAY = 24 * 60 * 60 * 1000;

export const FRECENCY_MAX_VISITS = 10;
export const HOST_PREFIX_BOOST = 1.5;

const AGE_BUCKETS: ReadonlyArray<readonly [maxAgeMs: number, weight: number]> = [
  [4 * DAY, 100],
  [14 * DAY, 70],
  [31 * DAY, 50],
  [90 * DAY, 20],
];

const TRANSITION_WEIGHTS: Readonly<Record<BrowserHistoryTransition, number>> = {
  typed: 2,
  suggestion: 2,
  link: 1,
  other: 1,
  reload: 0.5,
  back_forward: 0.5,
  agent: 0.3,
  redirect: 0,
};

export interface FrecencyVisit {
  readonly visitedAt: number;
  readonly transition: BrowserHistoryTransition;
  readonly source: BrowserHistorySource;
}

export function ageWeight(ageMs: number): number {
  for (const [maxAge, weight] of AGE_BUCKETS) if (ageMs <= maxAge) return weight;
  return 0;
}

export function transitionWeight(visit: FrecencyVisit): number {
  // An agent navigation counts as an agent visit whatever transition it used.
  return visit.source === "agent" ? TRANSITION_WEIGHTS.agent : TRANSITION_WEIGHTS[visit.transition];
}

export function frecencyScore(input: {
  readonly visits: ReadonlyArray<FrecencyVisit>;
  readonly typedCount: number;
  readonly now: number;
  readonly hostPrefixMatch?: boolean;
}): number {
  const latest = input.visits.toSorted((a, b) => b.visitedAt - a.visitedAt);
  let score = 0;
  for (const visit of latest.slice(0, FRECENCY_MAX_VISITS)) {
    score += ageWeight(Math.max(0, input.now - visit.visitedAt)) * transitionWeight(visit);
  }
  score *= 1 + (0.5 * Math.min(input.typedCount, FRECENCY_MAX_VISITS)) / FRECENCY_MAX_VISITS;
  if (input.hostPrefixMatch) score *= HOST_PREFIX_BOOST;
  return score;
}

/** True when the typed text (scheme and `www.` ignored) is a prefix of the URL's host. */
export function typedPrefixesHost(typed: string, url: string): boolean {
  const term = typed
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, "")
    .replace(/^www\./, "");
  if (term.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return host.startsWith(term) || term.startsWith(host);
}
