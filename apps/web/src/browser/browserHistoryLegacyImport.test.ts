import { BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  importLegacyBrowserHistory,
  LEGACY_BROWSER_HISTORY_STORAGE_KEY,
  parseLegacyBrowserHistory,
} from "./browserHistoryLegacyImport";

function persisted(byProjectKey: Record<string, unknown>): string {
  return JSON.stringify({ state: { byProjectKey, projectKeyByThreadKey: {} }, version: 1 });
}

function memoryStorage(initial: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("parseLegacyBrowserHistory", () => {
  it("merges every project into one list, keeping the latest visit per URL", () => {
    const entries = parseLegacyBrowserHistory(
      persisted({
        a: [
          { url: "http://localhost:3000/#top", lastVisitedAt: 100, title: "Old" },
          { url: "https://user:pw@example.com/docs", lastVisitedAt: 50 },
        ],
        b: [
          { url: "http://localhost:3000/", lastVisitedAt: 300 },
          { url: "ftp://example.com/", lastVisitedAt: 400 },
          { url: "https://bad.test/", lastVisitedAt: "soon" },
        ],
      }),
    );
    expect(entries).toEqual([
      { url: "http://localhost:3000/", lastVisitedAt: 300, title: "Old" },
      { url: "https://example.com/docs", lastVisitedAt: 50 },
    ]);
  });

  it("returns nothing for missing or malformed data", () => {
    expect(parseLegacyBrowserHistory(null)).toEqual([]);
    expect(parseLegacyBrowserHistory("not json")).toEqual([]);
    expect(parseLegacyBrowserHistory(JSON.stringify({ state: { byProjectKey: [] } }))).toEqual([]);
  });

  it("caps the import at the newest entries", () => {
    const many = Array.from({ length: BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES + 5 }, (_, i) => ({
      url: `https://site.test/${i}`,
      lastVisitedAt: i,
    }));
    const entries = parseLegacyBrowserHistory(persisted({ a: many }));
    expect(entries).toHaveLength(BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES);
    expect(entries[0]?.lastVisitedAt).toBe(BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES + 4);
  });
});

describe("importLegacyBrowserHistory", () => {
  const raw = persisted({ a: [{ url: "https://example.com/", lastVisitedAt: 1 }] });

  it("removes the old key only after the desktop app accepts the import", async () => {
    const storage = memoryStorage({ [LEGACY_BROWSER_HISTORY_STORAGE_KEY]: raw });
    const importLegacy = vi.fn().mockResolvedValue({ imported: 1 });
    await importLegacyBrowserHistory({ importLegacy }, storage);
    expect(importLegacy).toHaveBeenCalledExactlyOnceWith({
      entries: [{ url: "https://example.com/", lastVisitedAt: 1 }],
    });
    expect(storage.getItem(LEGACY_BROWSER_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it("keeps the old key when the import fails so the next launch retries", async () => {
    const storage = memoryStorage({ [LEGACY_BROWSER_HISTORY_STORAGE_KEY]: raw });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importLegacyBrowserHistory(
      { importLegacy: vi.fn().mockRejectedValue(new Error("db closed")) },
      storage,
    );
    expect(storage.getItem(LEGACY_BROWSER_HISTORY_STORAGE_KEY)).toBe(raw);
    warn.mockRestore();
  });

  it("does nothing outside the desktop app or without old history", async () => {
    const importLegacy = vi.fn();
    const storage = memoryStorage({ [LEGACY_BROWSER_HISTORY_STORAGE_KEY]: raw });
    await importLegacyBrowserHistory(null, storage);
    await importLegacyBrowserHistory({ importLegacy }, memoryStorage({}));
    expect(importLegacy).not.toHaveBeenCalled();
    expect(storage.getItem(LEGACY_BROWSER_HISTORY_STORAGE_KEY)).toBe(raw);
  });
});
