import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { LEGACY_BROWSER_HISTORY_STORAGE_KEY } from "@t3tools/shared/browserHistoryLegacy";

import { importLegacyOriginHistory, type LegacyOriginStorage } from "./LegacyOriginHistory.ts";

const NOW = Date.UTC(2026, 10, 5, 12);

function legacyStorage(initial: Record<string, string>) {
  const items = new Map(Object.entries(initial));
  const closed = { value: false };
  const storage: LegacyOriginStorage = {
    read: async (key) => items.get(key) ?? null,
    remove: async (key) => void items.delete(key),
    close: () => {
      closed.value = true;
    },
  };
  return { storage, items, closed };
}

const persisted = JSON.stringify({
  state: {
    byProjectKey: {
      p1: [{ url: "https://docs.example/a#x", title: "Docs", lastVisitedAt: NOW - 1000 }],
      p2: [{ url: "javascript:alert(1)", title: "bad", lastVisitedAt: NOW }],
    },
  },
  version: 0,
});

describe("history left under the old renderer origin", () => {
  it("is imported once, then removed from the old origin", async () => {
    const { storage, items, closed } = legacyStorage({
      [LEGACY_BROWSER_HISTORY_STORAGE_KEY]: persisted,
    });
    const imported: Array<unknown> = [];
    const outcome = await importLegacyOriginHistory({
      open: async () => storage,
      importLegacy: async (entries) => void imported.push(...entries),
    });
    expect(outcome).toBe("imported");
    expect(imported).toEqual([
      { url: "https://docs.example/a", title: "Docs", lastVisitedAt: NOW - 1000 },
    ]);
    expect(items.has(LEGACY_BROWSER_HISTORY_STORAGE_KEY)).toBe(false);
    expect(closed.value).toBe(true);
  });

  it("keeps the old data when the import fails, so it is retried", async () => {
    const { storage, items, closed } = legacyStorage({
      [LEGACY_BROWSER_HISTORY_STORAGE_KEY]: persisted,
    });
    await expect(
      importLegacyOriginHistory({
        open: async () => storage,
        importLegacy: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(items.has(LEGACY_BROWSER_HISTORY_STORAGE_KEY)).toBe(true);
    expect(closed.value).toBe(true);
  });

  it("reports nothing to do when the old origin has no history or cannot be opened", async () => {
    const importLegacy = vi.fn(async () => {});
    const empty = legacyStorage({});
    expect(await importLegacyOriginHistory({ open: async () => empty.storage, importLegacy })).toBe(
      "empty",
    );
    expect(await importLegacyOriginHistory({ open: async () => null, importLegacy })).toBe(
      "unavailable",
    );
    expect(importLegacy).not.toHaveBeenCalled();
  });
});
