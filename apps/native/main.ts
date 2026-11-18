import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";

import {
  APP_VERSION_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  UPDATE_READY_CHANNEL,
  UPDATE_STATE_CHANNEL,
} from "../web/lib/desktop-bridge";
import { SERVER_TOKEN_COOKIE } from "../web/lib/server-token";
import { startBackground, type Background } from "./background";
import {
  createSelfCheck,
  createSelfCheckDataFolder,
  isolateSelfCheckProfile,
  SELF_CHECK_TIMEOUT_MS,
  selfCheckOutputPath,
} from "./self-check";
import { serverEntry, startServer, type ServerHandle } from "./server-process";
import { installLoginShellPath } from "./shell-env";
import { startUpdates, type Updates } from "./updates";

const selfCheckPath = selfCheckOutputPath(process.argv);
if (selfCheckPath) isolateSelfCheckProfile();
if (!app.isPackaged) app.setName("BusyBoy (dev)");
let server: ServerHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let background: Background | null = null;
let updates: Updates | null = null;
let quitting = false;

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

function isAppOrigin(url: string | undefined) {
  if (!server || !url) return false;
  try {
    return new URL(url).origin === new URL(server.url).origin;
  } catch {
    return false;
  }
}

function openExternally(target: string) {
  if (/^https?:/.test(target)) void shell.openExternal(target);
}

function devIconPath() {
  if (app.isPackaged) return undefined;
  const icon = join(__dirname, "..", "icons", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

function createWindow(url: string, show: boolean) {
  const devIcon = devIconPath();
  if (devIcon && process.platform === "darwin") app.dock?.setIcon(devIcon);
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 480,
    show: false,
    title: "BusyBoy",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(devIcon && process.platform !== "darwin" ? { icon: devIcon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  if (process.platform === "darwin") {
    window.webContents.on("dom-ready", () => {
      void window.webContents.insertCSS(":root { --title-bar-inset: 80px; }");
    });
  }

  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (isAppOrigin(event.url)) return;
    event.preventDefault();
    if (event.isMainFrame) openExternally(event.url);
  };
  window.webContents.on("will-navigate", guard);
  window.webContents.on("will-redirect", guard);
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) guard(event);
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target);
    return { action: "deny" };
  });

  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("session-end", () => {
    quitting = true;
    app.quit();
  });

  if (show) window.once("ready-to-show", () => window.show());
  void window.loadURL(url);
  return window;
}

function screenUrl(base: string) {
  return base;
}

function openWindow() {
  if (!server || quitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(screenUrl(server.url), true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function windowInFront() {
  return Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused(),
  );
}

async function authorizeWindowSession(handle: ServerHandle) {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(requestingOrigin),
  );
  await session.defaultSession.cookies.set({
    url: handle.url,
    name: SERVER_TOKEN_COOKIE,
    value: handle.token,
    httpOnly: true,
    sameSite: "strict",
  });
}

async function runSelfCheck(outputPath: string) {
  const check = createSelfCheck();
  const removeDataFolder = createSelfCheckDataFolder();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    try {
      removeDataFolder();
    } catch (error) {
      console.error(error);
    }
    app.exit(check.write(outputPath) ? 0 : 1);
  };
  const watchdog = setTimeout(() => {
    check.fail(new Error(`The self-check did not finish within ${SELF_CHECK_TIMEOUT_MS} ms.`));
    finish();
  }, SELF_CHECK_TIMEOUT_MS);
  try {
    check.recordShellPath(await installLoginShellPath());
    check.snapshotServerFolder(dirname(serverEntry()));
    server = await startServer();
    await check.recordServer(server);
    await authorizeWindowSession(server);
    const window = (mainWindow = createWindow(server.url, false));
    await check.recordPage(window);
    background = startBackground(server, {
      open: openWindow,
      quit: () => {},
      installUpdate: () => {},
      windowInFront,
      notify: false,
    });
    await check.recordBackground(background, window, server);
    background.stop();
    background = null;
    window.destroy();
    await check.recordServerStop(server);
    check.recordServerFolderUnchanged();
  } catch (error) {
    check.fail(error);
    background?.stop();
    await server?.stop();
  } finally {
    finish();
  }
}

async function launch() {
  const shellPath = await installLoginShellPath();
  if (shellPath.error) console.warn(`Using the inherited PATH: ${shellPath.error}`);
  server = await startServer();
  await authorizeWindowSession(server);
  mainWindow = createWindow(server.url, true);
  background = startBackground(server, {
    open: openWindow,
    quit: () => app.quit(),
    installUpdate: () => void updates?.install(),
    windowInFront,
  });
  updates = startUpdates({
    onReady: (version) => {
      background?.updateReady(version);
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send(UPDATE_READY_CHANNEL, version);
    },
    beforeInstall: async () => {
      quitting = true;
      updates?.stop();
      background?.stop();
      background = null;
      await server?.stop();
    },
    installFailed: () => {
      app.relaunch();
      app.exit(0);
    },
  });
  app.on("activate", () => openWindow());
}

function registerUpdateActions() {
  ipcMain.handle(APP_VERSION_CHANNEL, (event) =>
    isAppOrigin(event.senderFrame?.url) ? app.getVersion() : null,
  );
  ipcMain.handle(UPDATE_STATE_CHANNEL, (event) =>
    isAppOrigin(event.senderFrame?.url) ? (updates?.readyVersion() ?? null) : null,
  );
  ipcMain.handle(INSTALL_UPDATE_CHANNEL, (event) => {
    if (isAppOrigin(event.senderFrame?.url)) void updates?.install();
  });
}

let stopping = 0;
const STALLED_SHUTDOWN_MS = 12_000;

function registerAppEvents() {
  app.on("second-instance", () => openWindow());

  app.on("window-all-closed", () => {});

  app.on("browser-window-focus", () => background?.windowFocused());
  app.on("browser-window-blur", () => background?.windowBlurred());

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", (event) => {
    if (!server?.isRunning()) return;
    event.preventDefault();
    if (stopping) {
      if (Date.now() - stopping >= STALLED_SHUTDOWN_MS) app.exit(0);
      return;
    }
    stopping = Date.now();
    updates?.stop();
    background?.stop();
    background = null;
    void server.stop().finally(() => app.exit(0));
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

  void app.whenReady().then(async () => {
    registerUpdateActions();
    if (selfCheckPath) {
      await runSelfCheck(selfCheckPath);
      return;
    }
    try {
      await launch();
    } catch (error) {
      console.error(error);
      dialog.showErrorBox(
        "BusyBoy could not start",
        error instanceof Error ? error.message : String(error),
      );
      await server?.stop();
      app.exit(1);
    }
  });
}

if (selfCheckPath || app.requestSingleInstanceLock()) {
  registerAppEvents();
} else {
  app.quit();
}
