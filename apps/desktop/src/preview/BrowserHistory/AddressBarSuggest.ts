import type { BrowserHistorySuggestResult, BrowserHistorySuggestion } from "@t3tools/contracts";

import { frecencyScore, typedPrefixesHost } from "./Frecency.ts";
import type { HistoryDatabase, SuggestionCandidate } from "./HistoryDatabase.ts";

/** How many matching URLs are scored per keystroke. */
export const SUGGESTION_CANDIDATE_LIMIT = 200;

const toSuggestion = (candidate: SuggestionCandidate): BrowserHistorySuggestion => ({
  url: candidate.url,
  title: candidate.title,
});

const lastVisitedAt = (candidate: SuggestionCandidate) =>
  candidate.visits.reduce((latest, visit) => Math.max(latest, visit.visitedAt), 0);

function rank(
  candidates: ReadonlyArray<SuggestionCandidate>,
  now: number,
  typed: string | null,
): SuggestionCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: frecencyScore({
        visits: candidate.visits,
        typedCount: candidate.typedCount,
        now,
        hostPrefixMatch: typed !== null && typedPrefixesHost(typed, candidate.url),
      }),
    }))
    .filter(({ score }) => score > 0)
    .toSorted(
      (a, b) => b.score - a.score || lastVisitedAt(b.candidate) - lastVisitedAt(a.candidate),
    )
    .map(({ candidate }) => candidate);
}

/** History matches for what the user typed, best first, plus what inline completion needs. */
export function suggestFromHistory(
  db: HistoryDatabase,
  input: { readonly text: string; readonly now: number; readonly limit: number },
): BrowserHistorySuggestResult {
  const terms = input.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { matches: [], topOrigin: null };
  const ranked = rank(
    db.suggestionCandidates({ terms, now: input.now, limit: SUGGESTION_CANDIDATE_LIMIT }),
    input.now,
    input.text,
  ).slice(0, input.limit);
  const top = ranked[0];
  let topOrigin: BrowserHistorySuggestResult["topOrigin"] = null;
  if (top !== undefined) {
    try {
      const url = `${new URL(top.url).origin}/`;
      topOrigin = { url, visitCount: db.aggregate(url)?.visitCount ?? 0 };
    } catch {}
  }
  return { matches: ranked.map(toSuggestion), topOrigin };
}

/** Zero-state "frequent sites": best-ranked URLs a person (not only an agent) visited. */
export function frequentFromHistory(
  db: HistoryDatabase,
  input: { readonly now: number; readonly limit: number },
): ReadonlyArray<BrowserHistorySuggestion> {
  return rank(
    db.suggestionCandidates({
      terms: [],
      now: input.now,
      limit: SUGGESTION_CANDIDATE_LIMIT,
      userVisitedOnly: true,
    }),
    input.now,
    null,
  )
    .slice(0, input.limit)
    .map(toSuggestion);
}
