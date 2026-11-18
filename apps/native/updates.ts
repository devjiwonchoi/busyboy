import { existsSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";
import { autoUpdater } from "electron-updater";

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 5 * 60_000;

const INSTALL_TIMEOUT_MS = 60_000;

export type UpdateOptions = {
  onReady: (version: string) => void;
  beforeInstall: () => Promise<void>;
  installFailed: () => void;
};

export function startUpdates(options: UpdateOptions) {
  let ready: string | null = null;
  let installing = false;
  const none = { readyVersion: () => ready, install: async () => {}, stop: () => {} };
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, "app-update.yml"))) return none;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    ready = info.version;
    options.onReady(info.version);
  });
  autoUpdater.on("error", (error) => console.warn(`Could not check for updates: ${error.message}`));

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  const first = setTimeout(check, FIRST_CHECK_MS);
  const every = setInterval(check, CHECK_EVERY_MS);

  return {
    readyVersion: () => ready,
    async install() {
      if (!ready || installing) return;
      installing = true;
      await options.beforeInstall();
      setTimeout(options.installFailed, INSTALL_TIMEOUT_MS);
      autoUpdater.quitAndInstall();
    },
    stop() {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}

export type Updates = ReturnType<typeof startUpdates>;
