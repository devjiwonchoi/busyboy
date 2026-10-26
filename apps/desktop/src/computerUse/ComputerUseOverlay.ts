/**
 * While an agent uses the computer, a small overlay at the top of the screen
 * says so, with a Stop button, and pressing Escape anywhere stops the agent.
 * The overlay never takes focus, so the user keeps typing in their own app.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { COMPUTER_USE_OVERLAY_CHANNEL } from "../ipc/channels.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import { startEscWatcher } from "./ComputerUseEscWatcher.ts";

export interface ComputerUseOverlayView {
  readonly show: (appName: string) => void;
  readonly hide: () => void;
  readonly dispose: () => void;
}

export interface ComputerUseOverlayController {
  readonly update: (status: DesktopBrowserHost.ComputerUseDesktopStatus) => void;
  readonly dispose: () => void;
}

/** Keeps the overlay and the Escape watcher in step with the backend's status. */
export function makeComputerUseOverlayController(dependencies: {
  readonly view: ComputerUseOverlayView;
  readonly startEscWatcher: typeof startEscWatcher;
  readonly requestStop: () => void;
  readonly onWatcherFailure: (error: Error) => void;
}): ComputerUseOverlayController {
  let acting = false;
  let stopWatcher: (() => void) | null = null;
  let starting = false;

  const startWatching = () => {
    if (stopWatcher !== null || starting) return;
    starting = true;
    dependencies
      .startEscWatcher(dependencies.requestStop, (error) => {
        stopWatcher = null;
        dependencies.onWatcherFailure(error);
      })
      .then(
        (stop) => {
          starting = false;
          // The agent may have finished while the watcher was starting.
          if (acting) stopWatcher = stop;
          else stop();
        },
        (error: Error) => {
          starting = false;
          dependencies.onWatcherFailure(error);
        },
      );
  };

  const stopWatching = () => {
    stopWatcher?.();
    stopWatcher = null;
  };

  return {
    update: (status) => {
      acting = status.acting;
      if (status.acting) {
        dependencies.view.show(status.appName ?? "an app");
        startWatching();
      } else {
        dependencies.view.hide();
        stopWatching();
      }
    },
    dispose: () => {
      acting = false;
      stopWatching();
      dependencies.view.dispose();
    },
  };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function overlayHtml(appName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Busyboy is using your computer</title><style>
:root { color-scheme: light dark; --base: rgba(255,255,255,.96); --text: #1f1f1f; --muted: #6b6b6b; --line: rgba(0,0,0,.12); --button: #e8e8e8; }
@media (prefers-color-scheme: dark) { :root { --base: rgba(36,36,36,.96); --text: #f5f5f5; --muted: #a8a8a8; --line: rgba(255,255,255,.14); --button: #3a3a3a; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body { font: 13px/18px -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text); user-select: none; }
main { display: flex; align-items: center; gap: 10px; height: 40px; margin: 2px; padding: 0 6px 0 14px; border: 1px solid var(--line); border-radius: 20px; background: var(--base); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; flex: none; }
p { margin: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
span { color: var(--muted); }
button { font: inherit; font-weight: 600; color: var(--text); border: 0; border-radius: 14px; padding: 4px 12px; background: var(--button); cursor: pointer; }
</style></head><body><main role="status">
<div class="dot" aria-hidden="true"></div>
<p>Busyboy is using ${escapeHtml(appName)} <span>· Esc to stop</span></p>
<button id="stop" type="button">Stop</button>
</main></body></html>`;
}

const OVERLAY_SIZE = { width: 380, height: 44 } as const;

/** The overlay window: created on first use, hidden rather than closed between turns. */
function makeOverlayWindowView(preload: string, onStop: () => void): ComputerUseOverlayView {
  let window: Electron.BrowserWindow | null = null;
  const onMessage = (event: Electron.IpcMainEvent, action: unknown) => {
    if (window === null || event.sender !== window.webContents || action !== "stop") return;
    onStop();
  };
  Electron.ipcMain.on(COMPUTER_USE_OVERLAY_CHANNEL, onMessage);

  const ensureWindow = () => {
    if (window !== null && !window.isDestroyed()) return window;
    window = new Electron.BrowserWindow({
      ...OVERLAY_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Never take focus: the user keeps typing in their own app.
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Busyboy is using your computer",
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    return window;
  };

  return {
    show: (appName) => {
      const overlay = ensureWindow();
      const area = Electron.screen.getPrimaryDisplay().workArea;
      overlay.setBounds({
        ...OVERLAY_SIZE,
        x: Math.round(area.x + (area.width - OVERLAY_SIZE.width) / 2),
        y: area.y + 8,
      });
      void overlay
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(appName))}`)
        .then(() => {
          if (!overlay.isDestroyed()) overlay.showInactive();
        })
        .catch(() => {});
    },
    hide: () => {
      if (window !== null && !window.isDestroyed()) window.hide();
    },
    dispose: () => {
      Electron.ipcMain.removeListener(COMPUTER_USE_OVERLAY_CHANNEL, onMessage);
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin") return;
  const path = yield* Path.Path;
  const host = yield* DesktopBrowserHost.DesktopBrowserHost;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const controller = makeComputerUseOverlayController({
    view: makeOverlayWindowView(
      path.join(environment.dirname, "computer-use-overlay-preload.cjs"),
      host.stopComputerUse,
    ),
    startEscWatcher,
    requestStop: host.stopComputerUse,
    // The Stop button still works; only Escape is lost.
    onWatcherFailure: (error) =>
      void runFork(Effect.logWarning("Escape watcher for computer use failed", error)),
  });
  // The backend refuses foreground input while the screen is locked, so it
  // must hear about every lock and unlock.
  const onLock = () => host.reportScreenLock(true);
  const onUnlock = () => host.reportScreenLock(false);
  Electron.powerMonitor.on("lock-screen", onLock);
  Electron.powerMonitor.on("unlock-screen", onUnlock);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.powerMonitor.removeListener("lock-screen", onLock);
      Electron.powerMonitor.removeListener("unlock-screen", onUnlock);
      controller.dispose();
    }),
  );
  yield* host.computerUse.pipe(
    Stream.runForEach((status) => Effect.sync(() => controller.update(status))),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
