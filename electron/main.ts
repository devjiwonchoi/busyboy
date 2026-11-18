import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, dirname, join, normalize } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";

import {
  FOCUS_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  OPEN_IN_EDITOR_CHANNEL,
  PICK_FOLDERS_CHANNEL,
  REVEAL_IN_FOLDER_CHANNEL,
  APP_VERSION_CHANNEL,
  UPDATE_READY_CHANNEL,
  UPDATE_STATE_CHANNEL,
} from "../src/lib/desktop-bridge";
import { FOCUS_PARAM, formatFocusTarget, type FocusTarget } from "../src/lib/focus-target";
import { SERVER_TOKEN_COOKIE } from "../src/lib/server-token";
import { findExecutable } from "../src/server/runner/find-executable";
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

function createWindow(url: string, show: boolean) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 480,
    show: false,
    title: "BusyBoy",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // why: Leave room for the macOS traffic lights in the custom title bar.
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
  // why: Windows ends the session (log off, shut down) without \`before-quit\`, so
  // why: the hidden-window rule above would keep agents from being stopped.
  window.on("session-end", () => {
    quitting = true;
    app.quit();
  });

  if (show) window.once("ready-to-show", () => window.show());
  void window.loadURL(url);
  return window;
}

function screenUrl(base: string, target?: FocusTarget) {
  if (!target) return base;
  const url = new URL(base);
  url.searchParams.set(FOCUS_PARAM, formatFocusTarget(target));
  return url.toString();
}

function openWindow(target?: FocusTarget) {
  if (!server || quitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(screenUrl(server.url, target), true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (target) mainWindow.webContents.send(FOCUS_CHANNEL, formatFocusTarget(target));
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
    await check.recordTerminal(server);
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

function registerFolderPicker() {
  ipcMain.handle(PICK_FOLDERS_CHANNEL, async (event) => {
    if (!isAppOrigin(event.senderFrame?.url)) return [];
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Add projects",
      buttonLabel: "Add",
      properties: ["openDirectory", "multiSelections", "createDirectory"],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
}

function localFolder(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) return null;
  const folder = normalize(value);
  try {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return null;
  } catch {
    return null;
  }
  return folder;
}

function editorCommand() {
  const configured = process.env.BUSYBOY_EDITOR;
  if (configured && !configured.includes("\0")) {
    return isAbsolute(configured) ? configured : (findExecutable(configured) ?? configured);
  }
  return (
    findExecutable("cursor") ||
    findExecutable("code") ||
    findExecutable("codium") ||
    findExecutable("subl")
  );
}

function registerWorktreeActions() {
  ipcMain.handle(OPEN_IN_EDITOR_CHANNEL, (event, folder: unknown) => {
    if (!isAppOrigin(event.senderFrame?.url)) return;
    const path = localFolder(folder);
    if (!path) return;
    const command = editorCommand();
    if (!command) {
      void shell.openPath(path);
      return;
    }
    try {
      const child = spawn(command, [path], { detached: true, stdio: "ignore" });
      child.on("error", () => void shell.openPath(path));
      child.unref();
    } catch {
      void shell.openPath(path);
    }
  });
  ipcMain.handle(REVEAL_IN_FOLDER_CHANNEL, (event, folder: unknown) => {
    if (!isAppOrigin(event.senderFrame?.url)) return;
    const path = localFolder(folder);
    if (path) shell.showItemInFolder(path);
  });
}

function registerUpdateActions() {
  // why: The shared Next bundle is built with package.json still at 0.0.0. The packaged app version is this one.
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
    registerFolderPicker();
    registerUpdateActions();
    registerWorktreeActions();
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
