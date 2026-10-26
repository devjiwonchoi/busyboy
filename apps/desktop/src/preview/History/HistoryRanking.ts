// Adapted from Min (https://github.com/minbrowser/min), js/places/placesService.js
// and js/places/placesSearch.js, licensed under Apache-2.0.
// Modified for Busyboy: rewritten in TypeScript as pure functions over plain
// entries; bookmarks, tags and Min's fuzzy quickScore fallback are left out.

export type HistoryEntry = {
  readonly url: string;
  readonly title: string;
  readonly visitCount: number;
  /** Milliseconds since the epoch. */
  readonly lastVisit: number;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Entries not visited for this long are dropped, as in Min. */
export const HISTORY_MAX_AGE_MS = ONE_DAY_MS * 42;

// Things that could be considered spaces.
const SPACES = /[+\s._/-]+/g;
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Min's frecency: recency scaled by a slowly growing visit-count factor, with
 * a bonus for short URLs (usually a site's front page). `boost` is the
 * relative bonus a search match earns.
 */
export const historyScore = (entry: HistoryEntry, boost: number): number => {
  let score = entry.lastVisit * (1 + 0.036 * Math.sqrt(entry.visitCount));
  if (entry.url.length < 20) {
    score += (30 - entry.url.length) * 2500;
  }
  return score + score * boost;
};

export const formatSearchTitle = (text: string): string =>
  text.toLowerCase().replace(SPACES, " ").normalize("NFD").replace(DIACRITICS, "");

/**
 * The order matters: the protocol must go before the spaces pattern removes
 * its slashes. Typed text goes through the same steps so the two compare.
 */
export const formatSearchUrl = (text: string): string =>
  (text.toLowerCase().split("?")[0] ?? "")
    .replace("http://", "")
    .replace("https://", "")
    .replace("www.", "")
    .replace(SPACES, " ")
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .trim();

const searchText = (entry: HistoryEntry) => {
  const url = formatSearchUrl(entry.url);
  return entry.title === entry.url ? url : `${url} ${formatSearchTitle(entry.title)}`;
};

/**
 * Matches typed text against history the way Min's address bar does: a match
 * at the start of the URL ranks far above one elsewhere, and text with spaces
 * also matches entries containing every word in any order.
 */
export const searchHistory = ({
  entries,
  text,
  limit,
}: {
  readonly entries: ReadonlyArray<HistoryEntry>;
  readonly text: string;
  readonly limit: number;
}): ReadonlyArray<HistoryEntry> => {
  const typed = formatSearchUrl(text);
  if (typed === "") {
    return [];
  }

  const words = typed.split(" ");
  const startBoost = Math.min(2.5 * text.length, 10);
  const containsBoost = 0.4 + 0.075 * text.length;
  const matchesEveryWord = text.includes(" ");

  const matches: Array<{ readonly entry: HistoryEntry; readonly score: number }> = [];
  for (const entry of entries) {
    const haystack = searchText(entry);
    const index = haystack.indexOf(typed);
    let boost: number | null = null;
    if (index === 0) {
      boost = startBoost;
    } else if (index !== -1) {
      boost = containsBoost;
    } else if (matchesEveryWord && words.every((word) => haystack.includes(word))) {
      boost = 0.125 * words.length + 0.02 * text.length;
    }

    if (boost !== null) {
      matches.push({ entry, score: historyScore(entry, boost) });
    }
  }

  return matches
    .toSorted((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
};
