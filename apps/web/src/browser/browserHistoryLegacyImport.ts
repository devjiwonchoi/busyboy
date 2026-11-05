import type { DesktopBrowserHistoryBridge } from "@t3tools/contracts";
import {
  LEGACY_BROWSER_HISTORY_STORAGE_KEY,
  parseLegacyBrowserHistory,
} from "@t3tools/shared/browserHistoryLegacy";

import { readBrowserHistoryBridge } from "./browserHistory";

export { LEGACY_BROWSER_HISTORY_STORAGE_KEY, parseLegacyBrowserHistory };

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
