import {
  BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES,
  BROWSER_HISTORY_MAX_TITLE_LENGTH,
  BROWSER_HISTORY_MAX_URL_LENGTH,
  type BrowserHistoryLegacyEntry,
  type DesktopBrowserHistoryBridge,
} from "@t3tools/contracts";

import { readBrowserHistoryBridge } from "./browserHistory";

/** Where the renderer kept per-project history before it moved to the desktop app. */
export const LEGACY_BROWSER_HISTORY_STORAGE_KEY = "t3code:browser-history:v1";

const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function normalizeLegacyUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.href.length > BROWSER_HISTORY_MAX_URL_LENGTH ? null : parsed.href;
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_VALID_DATE_MS
  );
}

/**
 * Flattens every project's entries from the persisted store JSON into one
 * list, newest first, with one entry per URL (the latest visit wins). Returns
 * an empty list for anything unreadable.
 */
export function parseLegacyBrowserHistory(raw: string | null): BrowserHistoryLegacyEntry[] {
  if (!raw) return [];
  let persisted: unknown;
  try {
    persisted = JSON.parse(raw);
  } catch {
    return [];
  }
  const state =
    persisted && typeof persisted === "object" ? (persisted as { state?: unknown }).state : null;
  const byProjectKey =
    state && typeof state === "object" ? (state as { byProjectKey?: unknown }).byProjectKey : null;
  if (!byProjectKey || typeof byProjectKey !== "object" || Array.isArray(byProjectKey)) return [];

  const byUrl = new Map<string, BrowserHistoryLegacyEntry>();
  for (const entries of Object.values(byProjectKey as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const candidate of entries) {
      if (!candidate || typeof candidate !== "object") continue;
      const { url, lastVisitedAt, title } = candidate as Record<string, unknown>;
      if (typeof url !== "string" || !isValidTimestamp(lastVisitedAt)) continue;
      const normalized = normalizeLegacyUrl(url);
      if (!normalized) continue;
      const trimmedTitle =
        typeof title === "string" ? title.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH) : "";
      const existing = byUrl.get(normalized);
      if (existing && existing.lastVisitedAt >= lastVisitedAt) {
        if (existing.title === undefined && trimmedTitle.length > 0) {
          byUrl.set(normalized, { ...existing, title: trimmedTitle });
        }
        continue;
      }
      const keptTitle = trimmedTitle.length > 0 ? trimmedTitle : existing?.title;
      byUrl.set(normalized, {
        url: normalized,
        lastVisitedAt,
        ...(keptTitle !== undefined ? { title: keptTitle } : {}),
      });
    }
  }
  return [...byUrl.values()]
    .toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES);
}

function readLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Moves the old localStorage history into the desktop history store. The key
 * is removed only after the desktop app confirms the import, so a failure is
 * retried on the next launch. Importing twice is harmless: desktop dedupes.
 */
export async function importLegacyBrowserHistory(
  bridge: Pick<DesktopBrowserHistoryBridge, "importLegacy"> | null = readBrowserHistoryBridge(),
  storage: Storage | null = readLocalStorage(),
): Promise<void> {
  if (!bridge || !storage) return;
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_BROWSER_HISTORY_STORAGE_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  const entries = parseLegacyBrowserHistory(raw);
  try {
    if (entries.length > 0) await bridge.importLegacy({ entries });
    storage.removeItem(LEGACY_BROWSER_HISTORY_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not move browsing history to the desktop app; retrying next launch", error);
  }
}

let started = false;

/** Runs the import once per launch. */
export function startLegacyBrowserHistoryImport(): void {
  if (started) return;
  started = true;
  void importLegacyBrowserHistory();
}
