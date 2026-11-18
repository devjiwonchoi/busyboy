import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { app, Notification, type BrowserWindow } from "electron";

import type { Background } from "./background";
import type { ServerHandle } from "./server-process";
import type { ShellPathResult } from "./shell-env";

const FLAG = "--self-check";
const LOAD_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
export const SELF_CHECK_TIMEOUT_MS = 90_000;
const STREAM_TIMEOUT_MS = 10_000;

export function selfCheckOutputPath(argv: string[]): string | null {
  const arg = argv.find((value) => value === FLAG || value.startsWith(`${FLAG}=`));
  if (!arg) return null;
  const value = arg.slice(FLAG.length + 1);
  return value ? resolve(value) : join(tmpdir(), "busyboy-self-check.json");
}

export function isolateSelfCheckProfile() {
  app.setPath("userData", mkdtempSync(join(tmpdir(), "busyboy-self-check-")));
}

export function createSelfCheckDataFolder() {
  const folder = mkdtempSync(join(tmpdir(), "busyboy-self-check-home-"));
  const at = new Date().toISOString();
  const settings = {
    version: 1,
    setupCompletedAt: at,
    defaultProvider: null,
    projects: [{ name: "self-check", path: folder, addedAt: at }],
  };
  writeFileSync(join(folder, "app-settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  process.env.BUSYBOY_HOME = folder;
  return () => rmSync(folder, { recursive: true, force: true });
}

type FolderSnapshot = Map<string, string>;

function snapshotFolder(dir: string): FolderSnapshot {
  const snapshot: FolderSnapshot = new Map();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      snapshot.set(path.slice(dir.length + 1), `${stat.size}:${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return snapshot;
}

function changedEntries(before: FolderSnapshot, after: FolderSnapshot) {
  const changed: string[] = [];
  for (const [path, stamp] of after) if (before.get(path) !== stamp) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed;
}

type SelfCheckResult = {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  versions: {
    app: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    arch: string;
  };
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
  error?: string;
};

export function createSelfCheck() {
  const started = Date.now();
  const result: SelfCheckResult = {
    ok: false,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    checks: {},
    details: {},
  };

  let serverFolder: { dir: string; before: FolderSnapshot } | undefined;

  return {
    result,
    recordShellPath(shellPath: ShellPathResult) {
      result.checks.shellPathResolved =
        shellPath.source === "login-shell" || process.platform === "win32";
      result.details.shellPath = shellPath;
    },
    async recordServer(server: ServerHandle) {
      result.checks.serverStarted = server.isRunning();
      result.details.serverUrl = server.url;
      const response = await fetch(`${server.url}/api/director/events`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      result.checks.serverRejectsMissingToken = response.status === 403;
    },
    async recordPage(window: BrowserWindow) {
      const contents = window.webContents;
      if (contents.isLoading()) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("The page did not load in time.")),
            LOAD_TIMEOUT_MS,
          );
          contents.once("did-finish-load", () => {
            clearTimeout(timer);
            resolve();
          });
          contents.once("did-fail-load", (_event, code, description) => {
            clearTimeout(timer);
            reject(new Error(`The page failed to load: ${code} ${description}`));
          });
        });
      }
      const readPage = async () =>
        (await contents.executeJavaScript(`({
          title: document.title,
          transcript: Boolean(document.querySelector('[role="log"][aria-label="Transcript"]')),
          composer: Boolean(document.querySelector('form textarea[name="text"]')),
          directorConnected: Boolean(document.querySelector('[role="log"][data-connected="true"]')),
        })`)) as Record<string, unknown>;
      const deadline = Date.now() + STREAM_TIMEOUT_MS;
      let page = await readPage();
      while (!page.directorConnected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        page = await readPage();
      }
      result.details.page = page;
      result.checks.pageLoaded = page.title === app.getName();
      result.checks.chatRendered = Boolean(page.transcript && page.composer);
      result.checks.directorStreamConnected = Boolean(page.directorConnected);
    },
    async recordBackground(background: Background, window: BrowserWindow, server: ServerHandle) {
      const labels = background.tray.menuLabels();
      result.details.trayMenu = labels;
      result.checks.trayMenuShown = ["Nothing needs you", "Open BusyBoy", "Quit BusyBoy"].every(
        (label) => labels.includes(label),
      );
      result.details.notificationsSupported = Notification.isSupported();
      window.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      result.checks.closeKeepsRunning =
        !window.isDestroyed() && !window.isVisible() && server.isRunning();
    },
    snapshotServerFolder(dir: string) {
      serverFolder = { dir, before: snapshotFolder(dir) };
    },
    recordServerFolderUnchanged() {
      if (!serverFolder) return;
      const changed = changedEntries(serverFolder.before, snapshotFolder(serverFolder.dir));
      result.checks.serverFolderUnchanged = changed.length === 0;
      if (changed.length > 0) result.details.serverFolderChanges = changed.slice(0, 20);
    },
    async recordServerStop(server: ServerHandle) {
      const stop = await server.stop();
      result.checks.serverStopped = !server.isRunning();
      result.checks.serverAcknowledgedShutdown = stop.acknowledged;
    },
    fail(error: unknown) {
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    },
    write(outputPath: string) {
      result.durationMs = Date.now() - started;
      result.ok =
        !result.error &&
        Object.keys(result.checks).length > 0 &&
        Object.values(result.checks).every(Boolean);
      const json = `${JSON.stringify(result, null, 2)}\n`;
      process.stdout.write(json);
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
      } catch (error) {
        process.stderr.write(
          `Could not write the self-check result to ${outputPath}: ${String(error)}\n`,
        );
        return false;
      }
      return result.ok;
    },
  };
}
