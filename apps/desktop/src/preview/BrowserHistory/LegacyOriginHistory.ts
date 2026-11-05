// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Plain Electron startup glue that runs outside an Effect runtime.
import type { BrowserHistoryLegacyEntry } from "@t3tools/contracts";
import {
  LEGACY_BROWSER_HISTORY_STORAGE_KEY,
  parseLegacyBrowserHistory,
} from "@t3tools/shared/browserHistoryLegacy";
import * as Electron from "electron";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

/**
 * The renderer's origins before BusyBoy got its own identity. Their
 * localStorage was copied into BusyBoy's profile but is invisible to the
 * `busyboy://` renderer, so main reads the old history once.
 */
export const LEGACY_RENDERER_SCHEMES = {
  production: "t3code",
  development: "t3code-dev",
} as const;

export const LEGACY_ORIGIN_MARKER_FILENAME = "legacy-origin-history-imported";

export interface LegacyOriginStorage {
  readonly read: (key: string) => Promise<string | null>;
  readonly remove: (key: string) => Promise<void>;
  readonly close: () => void;
}

/**
 * Imports the old origin's browsing history, then removes it. The key is only
 * removed after the import succeeds, so a failure is retried next launch.
 */
export async function importLegacyOriginHistory(input: {
  readonly open: () => Promise<LegacyOriginStorage | null>;
  readonly importLegacy: (entries: ReadonlyArray<BrowserHistoryLegacyEntry>) => Promise<void>;
}): Promise<"imported" | "empty" | "unavailable"> {
  const storage = await input.open().catch(() => null);
  if (storage === null) return "unavailable";
  try {
    const raw = await storage.read(LEGACY_BROWSER_HISTORY_STORAGE_KEY);
    if (raw === null) return "empty";
    const entries = parseLegacyBrowserHistory(raw);
    if (entries.length > 0) await input.importLegacy(entries);
    await storage.remove(LEGACY_BROWSER_HISTORY_STORAGE_KEY);
    return entries.length > 0 ? "imported" : "empty";
  } finally {
    storage.close();
  }
}

/** Privileges the old schemes need for localStorage; registered before `ready`. */
export const legacyRendererSchemePrivileges = (): ReadonlyArray<Electron.CustomScheme> =>
  Object.values(LEGACY_RENDERER_SCHEMES).map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true },
  }));

/** Loads a blank page on the old origin, hidden, in the default session. */
export async function openLegacyOriginStorage(
  isDevelopment: boolean,
): Promise<LegacyOriginStorage | null> {
  const scheme = isDevelopment
    ? LEGACY_RENDERER_SCHEMES.development
    : LEGACY_RENDERER_SCHEMES.production;
  Electron.protocol.handle(
    scheme,
    () =>
      new Response("<!doctype html><title></title>", {
        headers: { "content-type": "text/html" },
      }),
  );
  const window = new Electron.BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const close = () => {
    if (!window.isDestroyed()) window.destroy();
    Electron.protocol.unhandle(scheme);
  };
  try {
    await window.loadURL(`${scheme}://app/`);
  } catch {
    close();
    return null;
  }
  const run = (code: string) => window.webContents.executeJavaScript(code, true);
  return {
    read: async (key) => {
      const value: unknown = await run(`localStorage.getItem(${JSON.stringify(key)})`);
      return typeof value === "string" ? value : null;
    },
    remove: async (key) => {
      await run(`localStorage.removeItem(${JSON.stringify(key)})`);
    },
    close,
  };
}

/**
 * Runs the import once per profile, after a visible window exists so closing
 * the hidden one never looks like the last window closing.
 */
export async function importLegacyOriginHistoryOnce(input: {
  readonly rootDirectory: string;
  readonly isDevelopment: boolean;
  readonly importLegacy: (entries: ReadonlyArray<BrowserHistoryLegacyEntry>) => Promise<void>;
  readonly onError: (cause: unknown) => void;
}): Promise<void> {
  const marker = NodePath.join(input.rootDirectory, LEGACY_ORIGIN_MARKER_FILENAME);
  if (NodeFs.existsSync(marker)) return;
  await Electron.app.whenReady();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (Electron.BrowserWindow.getAllWindows().some((window) => window.isVisible())) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!Electron.BrowserWindow.getAllWindows().some((window) => window.isVisible())) return;
  try {
    const outcome = await importLegacyOriginHistory({
      open: () => openLegacyOriginStorage(input.isDevelopment),
      importLegacy: input.importLegacy,
    });
    if (outcome !== "unavailable") {
      NodeFs.mkdirSync(input.rootDirectory, { recursive: true });
      NodeFs.writeFileSync(marker, `${new Date().toISOString()} ${outcome}\n`);
    }
  } catch (cause) {
    input.onError(cause);
  }
}
