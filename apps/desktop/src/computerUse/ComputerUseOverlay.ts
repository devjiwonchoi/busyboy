// @effect-diagnostics nodeBuiltinImport:off - Reads another app's window frame with osascript.
// @effect-diagnostics globalTimers:off - The linger timer is injectable for tests.
/**
 * The "BusyBoy is using <App> · Esc to stop" overlay. It watches the traffic
 * through the computer-use channel host: an `app.act` in flight shows it, and
 * it stays up for a short linger after the last action so bursts do not
 * flicker. A stop, `session.end`, a lock, or turning computer use off hides it
 * at once.
 *
 * The helper reports window ids as `w<CGWindowID>` but no frames, so the
 * desktop looks the frame up itself with `CGWindowListCopyWindowInfo` (bounds
 * need no Screen Recording grant). Without a frame the pill alone shows on the
 * display under the pointer.
 */
import * as NodeChildProcess from "node:child_process";

import * as Electron from "electron";

import { markAuxiliaryWindow } from "../electron/AuxiliaryWindows.ts";
import { systemTimers, type SupervisorTimers } from "./HelperSupervisor.ts";

/** How long the overlay stays after the last action ends. */
export const OVERLAY_LINGER_MS = 1_500;
/** A frame lookup slower than this shows the pill without a border first. */
export const FRAME_LOOKUP_TIMEOUT_MS = 500;
/** A frame this fresh is reused for the same target instead of looked up again. */
export const FRAME_FRESH_MS = 500;
/** Most apps, windows, and stopped turns remembered at once. */
const MEMORY_LIMIT = 64;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OverlayModel {
  readonly appName: string;
  /** Target window frame relative to the overlay window, if known. */
  readonly frame: Rect | null;
}

/**
 * The overlay window, as the controller needs it. The controller creates one
 * when it shows and destroys it when it hides, so no hidden window outlives
 * the overlay.
 */
export interface OverlayWindow {
  readonly setBounds: (bounds: Rect) => void;
  readonly render: (model: OverlayModel) => void;
  readonly showInactive: () => void;
  readonly destroy: () => void;
}

export interface ComputerUseOverlayOptions {
  readonly createWindow: () => OverlayWindow;
  /** Global frame of `w<id>` owned by `pid`, or null. */
  readonly locateFrame: (pid: number, windowId: string) => Promise<Rect | null>;
  /** Bounds of the display holding `frame`, or of the display under the pointer. */
  readonly displayBounds: (frame: Rect | null) => Rect;
  readonly timers?: SupervisorTimers;
  readonly lingerMs?: number;
  readonly frameLookupTimeoutMs?: number;
}

/** Observes the channel host without changing its routing. */
export interface ComputerUseTrafficObserver {
  readonly request: (id: number, method: string, params: unknown) => void;
  readonly response: (
    id: number,
    method: string,
    params: unknown,
    outcome: { readonly result?: unknown; readonly error?: { readonly code: string } },
  ) => void;
  readonly notification: (method: string, params: unknown) => void;
  readonly configured: (enabled: boolean) => void;
}

interface KnownApp {
  readonly name: string;
  readonly pid: number | null;
  readonly windowId: string | null;
}

interface Target extends KnownApp {
  readonly turnId: string;
}

interface CachedFrame {
  readonly frame: Rect;
  readonly at: number;
}

/** Adds to a size-capped map, dropping the oldest entry first. */
const remember = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value as K);
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const stringField = (value: unknown, key: string): string | null => {
  const field = record(value)?.[key];
  return typeof field === "string" ? field : null;
};

/** App identity and window from an `app.state` or `app.act` result. */
const learnedFrom = (method: string, result: unknown): KnownApp | null => {
  const app = record(record(result)?.app);
  const name = stringField(app, "name");
  if (name === null) return null;
  const pid = typeof app?.pid === "number" ? app.pid : null;
  const state = method === "app.state" ? result : record(result)?.state;
  return { name, pid, windowId: stringField(state, "window") };
};

const relative = (frame: Rect, to: Rect): Rect => ({
  x: frame.x - to.x,
  y: frame.y - to.y,
  width: frame.width,
  height: frame.height,
});

export class ComputerUseOverlay implements ComputerUseTrafficObserver {
  private readonly options: ComputerUseOverlayOptions;
  private readonly timers: SupervisorTimers;
  private readonly lingerMs: number;
  private window: OverlayWindow | null = null;
  private visible = false;
  private target: Target | null = null;
  /** Bumped on every hide and target change, so late frame lookups are dropped. */
  private generation = 0;
  private lingerTimer: unknown = null;
  /** `app.act` requests in flight: id → turn. */
  private readonly inFlight = new Map<number, string>();
  /** Turns stopped by the user; their late actions must not show the overlay again. */
  private readonly stoppedTurns = new Map<string, true>();
  /** What earlier results said about each `app` argument. */
  private readonly known = new Map<string, KnownApp>();
  private readonly frames = new Map<string, CachedFrame>();
  /** At most one frame lookup per window runs at a time. */
  private readonly lookups = new Map<string, Promise<Rect | null>>();
  private disposed = false;

  constructor(options: ComputerUseOverlayOptions) {
    this.options = options;
    this.timers = options.timers ?? systemTimers;
    this.lingerMs = options.lingerMs ?? OVERLAY_LINGER_MS;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  request(id: number, method: string, params: unknown): void {
    if (this.disposed) return;
    if (method === "session.begin") {
      const turnId = stringField(params, "turnId");
      if (turnId !== null) this.stoppedTurns.delete(turnId);
      return;
    }
    if (method === "session.end") {
      const turnId = stringField(params, "turnId");
      if (turnId !== null) {
        this.endTurn(turnId);
        // The turn is over, so the server sends nothing more for it.
        this.stoppedTurns.delete(turnId);
      }
      return;
    }
    if (method !== "app.act") return;
    const turnId = stringField(params, "turnId");
    const app = stringField(params, "app");
    if (turnId === null || app === null || this.stoppedTurns.has(turnId)) return;
    this.inFlight.set(id, turnId);
    this.clearLinger();
    const known = this.known.get(app);
    const windowId = stringField(record(params)?.action, "window") ?? known?.windowId ?? null;
    this.present({ turnId, name: known?.name ?? app, pid: known?.pid ?? null, windowId });
  }

  response(
    id: number,
    method: string,
    params: unknown,
    outcome: { readonly result?: unknown; readonly error?: { readonly code: string } },
  ): void {
    if (this.disposed) return;
    if (method !== "app.act" && method !== "app.state") return;
    const app = stringField(params, "app");
    const fresh = outcome.result === undefined ? null : learnedFrom(method, outcome.result);
    // An `app.act` without `state` names no window; keep the one we knew.
    const before = app === null ? undefined : this.known.get(app);
    const learned =
      fresh === null
        ? null
        : {
            name: fresh.name,
            pid: fresh.pid ?? before?.pid ?? null,
            windowId: fresh.windowId ?? before?.windowId ?? null,
          };
    if (app !== null && learned !== null) remember(this.known, app, learned);

    const turnId = this.inFlight.get(id);
    if (turnId === undefined) return;
    this.inFlight.delete(id);
    if (outcome.error?.code === "stopped") {
      this.endTurn(turnId, true);
      return;
    }
    if (learned !== null && this.target?.turnId === turnId) {
      this.present({
        turnId,
        name: learned.name,
        pid: learned.pid ?? this.target.pid,
        windowId: learned.windowId ?? this.target.windowId,
      });
    }
    if (this.inFlight.size === 0) this.scheduleHide();
  }

  notification(method: string, params: unknown): void {
    if (this.disposed) return;
    if (method === "stopped") {
      const turnId = stringField(params, "turnId");
      // A lock pauses the turn but does not end it: the agent may go on after unlock.
      if (turnId !== null && stringField(params, "reason") !== "screen_locked") {
        this.endTurn(turnId, true);
      } else {
        this.hideNow();
      }
      return;
    }
    if (method === "lock_changed" && record(params)?.locked === true) this.hideNow();
  }

  configured(enabled: boolean): void {
    if (enabled) return;
    this.inFlight.clear();
    this.stoppedTurns.clear();
    this.known.clear();
    this.frames.clear();
    this.hideNow();
  }

  /** Hides and releases the window for good, e.g. on app quit. */
  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
    this.hideNow();
  }

  private endTurn(turnId: string, stopped = false): void {
    if (stopped) remember(this.stoppedTurns, turnId, true);
    for (const [id, turn] of this.inFlight) if (turn === turnId) this.inFlight.delete(id);
    if (this.target === null || this.target.turnId === turnId) this.hideNow();
  }

  private scheduleHide(): void {
    this.clearLinger();
    this.lingerTimer = this.timers.setTimeout(() => {
      this.lingerTimer = null;
      if (this.inFlight.size === 0) this.hideNow();
    }, this.lingerMs);
  }

  private clearLinger(): void {
    if (this.lingerTimer !== null) this.timers.clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private hideNow(): void {
    this.clearLinger();
    this.generation += 1;
    this.target = null;
    this.visible = false;
    // Destroy rather than hide: a hidden window would linger in the app's window list.
    this.window?.destroy();
    this.window = null;
  }

  private present(target: Target): void {
    const same =
      this.target !== null &&
      this.target.turnId === target.turnId &&
      this.target.name === target.name &&
      this.target.pid === target.pid &&
      this.target.windowId === target.windowId;
    this.target = target;
    const entry = target.windowId === null ? undefined : this.frames.get(target.windowId);
    const cached = entry?.frame ?? null;
    if (!same) this.generation += 1;
    const generation = this.generation;

    if (target.pid === null || target.windowId === null) {
      this.draw(target, null);
      return;
    }
    // A known frame draws at once; a fresh lookup corrects it if the window moved.
    if (cached !== null || this.visible) this.draw(target, cached);
    // Each lookup spawns a process, so skip it when the frame is still fresh.
    if (same && entry !== undefined && this.timers.now() - entry.at < FRAME_FRESH_MS) return;
    const windowId = target.windowId;
    let settled = false;
    const fallback = this.timers.setTimeout(() => {
      if (!settled && generation === this.generation && !this.visible) this.draw(target, null);
    }, this.options.frameLookupTimeoutMs ?? FRAME_LOOKUP_TIMEOUT_MS);
    void this.lookup(target.pid, windowId).then((frame) => {
      settled = true;
      this.timers.clearTimeout(fallback);
      if (generation !== this.generation || this.target !== target) return;
      this.draw(target, frame ?? cached);
    });
  }

  /** Looks a window's frame up, joining a lookup already running for it. */
  private lookup(pid: number, windowId: string): Promise<Rect | null> {
    const running = this.lookups.get(windowId);
    if (running !== undefined) return running;
    const lookup = this.options
      .locateFrame(pid, windowId)
      .catch(() => null)
      .then((frame) => {
        this.lookups.delete(windowId);
        if (frame !== null) remember(this.frames, windowId, { frame, at: this.timers.now() });
        return frame;
      });
    this.lookups.set(windowId, lookup);
    return lookup;
  }

  private draw(target: Target, frame: Rect | null): void {
    if (this.disposed) return;
    const display = this.options.displayBounds(frame);
    this.window ??= this.options.createWindow();
    this.window.setBounds(display);
    this.window.render({
      appName: target.name,
      frame: frame === null ? null : relative(frame, display),
    });
    if (!this.visible) {
      this.visible = true;
      this.window.showInactive();
    }
  }
}

// ---------------------------------------------------------------------------
// Electron and macOS backing

const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;-webkit-user-select:none;cursor:default}
#border{position:absolute;display:none;box-sizing:border-box;border:2px solid rgba(64,140,255,.85);border-radius:12px;box-shadow:0 0 0 4px rgba(64,140,255,.18),0 0 24px rgba(64,140,255,.35)}
#pill{position:absolute;display:flex;align-items:center;gap:6px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(20,22,28,.86);color:#fff;font:500 12px/16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.25)}
#dot{width:7px;height:7px;border-radius:50%;background:#4b8dff}
#hint{color:rgba(255,255,255,.65)}
</style><div id="border"></div><div id="pill"><span id="dot"></span><span id="label"></span><span id="hint">· Esc to stop</span></div><script>
const border=document.getElementById("border"),pill=document.getElementById("pill");
window.renderOverlay=(model)=>{
  document.getElementById("label").textContent="BusyBoy is using "+model.appName;
  const f=model.frame;
  if(f){
    Object.assign(border.style,{display:"block",left:f.x+"px",top:f.y+"px",width:f.width+"px",height:f.height+"px"});
    Object.assign(pill.style,{left:(f.x+f.width/2)+"px",top:Math.max(8,f.y+10)+"px"});
  }else{
    border.style.display="none";
    Object.assign(pill.style,{left:"50%",top:"36px"});
  }
};
</script>`;

/** A transparent, click-through panel that never takes focus. */
export const createElectronOverlayWindow = (): OverlayWindow => {
  const window = new Electron.BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    title: "BusyBoy Computer Use",
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Keeps it out of the app's own window list (Dock activate, deep links, theme sync).
  markAuxiliaryWindow(window);
  window.setIgnoreMouseEvents(true);
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  let pending: OverlayModel | null = null;
  let loaded = false;
  const apply = (model: OverlayModel) => {
    if (window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`window.renderOverlay(${JSON.stringify(model)})`)
      .catch(() => undefined);
  };
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`)
    .then(() => {
      loaded = true;
      if (pending !== null) apply(pending);
    })
    .catch(() => undefined);
  return {
    setBounds: (bounds) => {
      if (!window.isDestroyed()) window.setBounds(bounds);
    },
    render: (model) => {
      pending = model;
      if (loaded) apply(model);
    },
    showInactive: () => {
      if (!window.isDestroyed()) window.showInactive();
    },
    destroy: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
};

export const electronDisplayBounds = (frame: Rect | null): Rect =>
  frame === null
    ? Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).bounds
    : Electron.screen.getDisplayMatching(frame).bounds;

/** Window bounds in global top-left points, the same space as Electron's screen API. */
const FRAME_SCRIPT = `ObjC.import("CoreGraphics");
function run(argv){
  const id=Number(argv[0]),pid=Number(argv[1]);
  const list=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionIncludingWindow,id)))||[];
  const w=list.find(i=>i.kCGWindowNumber===id&&i.kCGWindowOwnerPID===pid);
  return w?JSON.stringify(w.kCGWindowBounds):"null";
}`;

/** Parses `w<cg_window_id>`, the helper's window id scheme. */
export const parseWindowNumber = (windowId: string): number | null => {
  const match = /^w(\d+)$/.exec(windowId);
  return match ? Number(match[1]) : null;
};

export const parseFrameOutput = (output: string): Rect | null => {
  try {
    const bounds = record(JSON.parse(output));
    if (bounds === null) return null;
    const { X: x, Y: y, Width: width, Height: height } = bounds;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (typeof width !== "number" || typeof height !== "number") return null;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  } catch {
    return null;
  }
};

export const locateMacWindowFrame = (pid: number, windowId: string): Promise<Rect | null> => {
  const number = parseWindowNumber(windowId);
  if (number === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", FRAME_SCRIPT, String(number), String(pid)],
      { timeout: 2_000 },
      (error, stdout) => resolve(error ? null : parseFrameOutput(stdout.trim())),
    );
  });
};

export const makeElectronOverlay = (): ComputerUseOverlay =>
  new ComputerUseOverlay({
    createWindow: createElectronOverlayWindow,
    locateFrame: locateMacWindowFrame,
    displayBounds: electronDisplayBounds,
  });
