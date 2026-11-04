import type {
  BrowserHistoryClearDataType,
  BrowserHistoryClearRange,
  BrowserHistoryVisit,
} from "@t3tools/contracts";

export interface BrowserHistoryDayGroup {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly key: string;
  readonly label: string;
  readonly visits: ReadonlyArray<BrowserHistoryVisit>;
}

const dayLabelFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const dayLabelWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayLabel(date: Date, now: Date): string {
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  return (
    date.getFullYear() === now.getFullYear() ? dayLabelFormatter : dayLabelWithYearFormatter
  ).format(date);
}

/** Groups newest-first visits by local calendar day, keeping their order. */
export function groupVisitsByDay(
  visits: ReadonlyArray<BrowserHistoryVisit>,
  nowMs: number = Date.now(),
): ReadonlyArray<BrowserHistoryDayGroup> {
  const now = new Date(nowMs);
  const groups: Array<{ key: string; label: string; visits: BrowserHistoryVisit[] }> = [];
  for (const visit of visits) {
    const date = new Date(visit.visitedAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = localDayKey(date);
    const last = groups.at(-1);
    if (last?.key === key) last.visits.push(visit);
    else groups.push({ key, label: dayLabel(date, now), visits: [visit] });
  }
  return groups;
}

export const BROWSER_HISTORY_CLEAR_RANGE_LABELS: Readonly<
  Record<BrowserHistoryClearRange, string>
> = {
  hour: "Last hour",
  day: "Last 24 hours",
  week: "Last 7 days",
  four_weeks: "Last 4 weeks",
  all: "All time",
};

export const BROWSER_HISTORY_CLEAR_DATA_TYPE_LABELS: Readonly<
  Record<BrowserHistoryClearDataType, string>
> = {
  history: "Browsing history",
  cookies_site_data: "Cookies and site data",
  cache: "Cached files",
};

/** Cookies and cache can't be cleared for a time window, only all at once. */
export function clearsSomeDataForAllTime(
  range: BrowserHistoryClearRange,
  dataTypes: ReadonlyArray<BrowserHistoryClearDataType>,
): boolean {
  return range !== "all" && dataTypes.some((type) => type !== "history");
}

export function visitHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
