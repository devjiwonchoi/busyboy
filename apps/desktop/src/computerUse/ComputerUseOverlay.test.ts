// @effect-diagnostics globalTimers:off - Flushes resolved frame lookups between steps.
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import {
  ComputerUseOverlay,
  parseFrameOutput,
  parseWindowNumber,
  type OverlayModel,
  type Rect,
} from "./ComputerUseOverlay.ts";
import type { SupervisorTimers } from "./HelperSupervisor.ts";

class FakeClock implements SupervisorTimers {
  private time = 0;
  private nextId = 0;
  private queue: Array<{ id: number; at: number; callback: () => void }> = [];
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.nextId;
    this.queue.push({ id, at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  };
  advance(ms: number) {
    const until = this.time + ms;
    for (;;) {
      const next = this.queue
        .filter((entry) => entry.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.queue = this.queue.filter((entry) => entry !== next);
      this.time = next.at;
      next.callback();
    }
    this.time = until;
  }
}

const DISPLAY: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const FRAME: Rect = { x: 100, y: 80, width: 600, height: 400 };

const setup = (frames: Record<string, Rect> = { w42: FRAME }) => {
  const clock = new FakeClock();
  const calls: Array<string> = [];
  const lookups: Array<string> = [];
  const models: Array<OverlayModel> = [];
  let created = 0;
  const overlay = new ComputerUseOverlay({
    timers: clock,
    createWindow: () => {
      created += 1;
      return {
        setBounds: () => {},
        render: (model) => models.push(model),
        showInactive: () => calls.push("show"),
        destroy: () => calls.push("hide"),
      };
    },
    locateFrame: async (_pid, windowId) => {
      lookups.push(windowId);
      return frames[windowId] ?? null;
    },
    displayBounds: () => DISPLAY,
  });
  return { overlay, clock, calls, models, lookups, windowsCreated: () => created };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const act = (turnId = "turn-1", app = "TextEdit") => ({
  threadId: "thread-1",
  turnId,
  app,
  action: { kind: "click", ref: "e3" },
});
const actResult = {
  app: { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 501 },
  verified: true,
  effect: {},
  method: "ax_press",
  state: { app: { name: "TextEdit" }, window: "w42", windows: [] },
};

describe("ComputerUseOverlay timing", () => {
  it("shows during an action and hides 1.5 s after the last one", async () => {
    const { overlay, clock, calls, models } = setup();
    overlay.request(1, "app.act", act());
    expect(overlay.isVisible).toBe(true);
    expect(calls).toEqual(["show"]);
    expect(models.at(-1)).toEqual({ appName: "TextEdit", frame: null });

    overlay.response(1, "app.act", act(), { result: actResult });
    await flush();
    // The result names the window, so the border follows its frame.
    expect(models.at(-1)).toEqual({ appName: "TextEdit", frame: FRAME });

    clock.advance(1_499);
    expect(overlay.isVisible).toBe(true);
    clock.advance(1);
    expect(overlay.isVisible).toBe(false);
    expect(calls).toEqual(["show", "hide"]);
  });

  it("stays up through a burst of actions without flicker", async () => {
    const { overlay, clock, calls } = setup();
    for (let id = 1; id <= 5; id++) {
      overlay.request(id, "app.act", act());
      clock.advance(200);
      overlay.response(id, "app.act", act(), { result: actResult });
      await flush();
      clock.advance(1_000);
    }
    expect(calls).toEqual(["show"]);
    clock.advance(1_500);
    expect(calls).toEqual(["show", "hide"]);
  });

  it("does not hide while another action is still running", () => {
    const { overlay, clock } = setup();
    overlay.request(1, "app.act", act());
    overlay.request(2, "app.act", act());
    overlay.response(1, "app.act", act(), { error: { code: "timeout" } });
    clock.advance(5_000);
    expect(overlay.isVisible).toBe(true);
    overlay.response(2, "app.act", act(), { error: { code: "timeout" } });
    clock.advance(1_500);
    expect(overlay.isVisible).toBe(false);
  });

  it("hides at once on stopped, and later results of that turn do not bring it back", () => {
    const { overlay, calls } = setup();
    overlay.request(1, "app.act", act());
    overlay.notification("stopped", {
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "user_escape",
    });
    expect(calls).toEqual(["show", "hide"]);
    overlay.response(1, "app.act", act(), { error: { code: "stopped" } });
    overlay.request(2, "app.act", act());
    expect(overlay.isVisible).toBe(false);

    // A new turn shows it again.
    overlay.request(3, "app.act", act("turn-2"));
    expect(overlay.isVisible).toBe(true);
  });

  it("hides at once on a stopped result, session.end, lock, and turning off", () => {
    const { overlay } = setup();
    overlay.request(1, "app.act", act());
    overlay.response(1, "app.act", act(), { error: { code: "stopped" } });
    expect(overlay.isVisible).toBe(false);

    overlay.request(2, "app.act", act("turn-2"));
    overlay.request(3, "session.end", { threadId: "thread-1", turnId: "turn-2" });
    expect(overlay.isVisible).toBe(false);

    overlay.request(4, "app.act", act("turn-3"));
    overlay.notification("lock_changed", { locked: true });
    expect(overlay.isVisible).toBe(false);

    overlay.request(5, "app.act", act("turn-4"));
    overlay.configured(false);
    expect(overlay.isVisible).toBe(false);
  });

  it("ignores session.end of another turn", () => {
    const { overlay } = setup();
    overlay.request(1, "app.act", act());
    overlay.request(2, "session.end", { threadId: "thread-1", turnId: "other" });
    expect(overlay.isVisible).toBe(true);
  });

  it("uses what app.state taught it to draw the border as the next action starts", async () => {
    const { overlay, models, windowsCreated } = setup();
    overlay.response(
      9,
      "app.state",
      { turnId: "turn-1", app: "textedit" },
      {
        result: { app: { name: "TextEdit", pid: 501 }, window: "w42", windows: [] },
      },
    );
    overlay.request(1, "app.act", act("turn-1", "textedit"));
    // Waits for the frame rather than flashing the pill elsewhere first.
    expect(overlay.isVisible).toBe(false);
    await flush();
    expect(overlay.isVisible).toBe(true);
    expect(models).toEqual([{ appName: "TextEdit", frame: FRAME }]);
    expect(windowsCreated()).toBe(1);
  });

  it("shows the pill alone when the frame lookup fails", async () => {
    const { overlay, models } = setup({});
    overlay.response(
      9,
      "app.state",
      { app: "TextEdit" },
      {
        result: { app: { name: "TextEdit", pid: 501 }, window: "w7", windows: [] },
      },
    );
    overlay.request(1, "app.act", act());
    await flush();
    expect(overlay.isVisible).toBe(true);
    expect(models.at(-1)).toEqual({ appName: "TextEdit", frame: null });
  });

  it("drops a frame that arrives after the overlay was hidden", async () => {
    const { overlay, calls } = setup();
    overlay.response(
      9,
      "app.state",
      { app: "TextEdit" },
      {
        result: { app: { name: "TextEdit", pid: 501 }, window: "w42", windows: [] },
      },
    );
    overlay.request(1, "app.act", act());
    overlay.configured(false);
    await flush();
    expect(overlay.isVisible).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("ComputerUseOverlay lifetime", () => {
  it("destroys the window when it hides and makes a new one for the next show", () => {
    const { overlay, clock, calls, windowsCreated } = setup();
    overlay.request(1, "app.act", act());
    overlay.response(1, "app.act", act(), { error: { code: "timeout" } });
    clock.advance(1_500);
    expect(calls).toEqual(["show", "hide"]);
    overlay.request(2, "app.act", act());
    expect(windowsCreated()).toBe(2);
  });

  it("comes back after a screen lock once the user unlocks", () => {
    const { overlay } = setup();
    overlay.request(1, "app.act", act());
    overlay.notification("lock_changed", { locked: true });
    overlay.notification("stopped", {
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "screen_locked",
    });
    overlay.response(1, "app.act", act(), { error: { code: "screen_locked" } });
    expect(overlay.isVisible).toBe(false);

    overlay.notification("lock_changed", { locked: false });
    overlay.request(2, "app.act", act());
    expect(overlay.isVisible).toBe(true);
  });

  it("keeps the known window when an action result carries no state", async () => {
    const { overlay, models } = setup();
    overlay.request(1, "app.act", act());
    overlay.response(1, "app.act", act(), { result: actResult });
    await flush();
    expect(models.at(-1)).toEqual({ appName: "TextEdit", frame: FRAME });

    // `return_state: false` leaves `state` out.
    const { state: _state, ...withoutState } = actResult;
    overlay.request(2, "app.act", act());
    overlay.response(2, "app.act", act(), { result: withoutState });
    await flush();
    expect(models.at(-1)).toEqual({ appName: "TextEdit", frame: FRAME });
  });

  it("reuses a fresh frame and runs one lookup per window at a time", async () => {
    const { overlay, clock, lookups } = setup();
    overlay.request(1, "app.act", act());
    overlay.response(1, "app.act", act(), { result: actResult });
    overlay.request(2, "app.act", act());
    overlay.response(2, "app.act", act(), { result: actResult });
    await flush();
    // Both results asked while the first lookup was running.
    expect(lookups).toEqual(["w42"]);

    overlay.request(3, "app.act", act());
    overlay.response(3, "app.act", act(), { result: actResult });
    await flush();
    expect(lookups).toEqual(["w42"]);

    // An old frame is looked up again in case the window moved.
    clock.advance(600);
    overlay.request(4, "app.act", act());
    await flush();
    expect(lookups).toEqual(["w42", "w42"]);
  });

  it("never shows again after dispose", () => {
    const { overlay, windowsCreated } = setup();
    overlay.dispose();
    overlay.request(1, "app.act", act());
    overlay.response(9, "app.state", { app: "TextEdit" }, { result: actResult.state });
    expect(overlay.isVisible).toBe(false);
    expect(windowsCreated()).toBe(0);
  });

  it("forgets a stopped turn once its session ends", () => {
    const { overlay } = setup();
    overlay.request(1, "app.act", act());
    overlay.notification("stopped", { turnId: "turn-1", reason: "user_escape" });
    overlay.request(2, "app.act", act());
    expect(overlay.isVisible).toBe(false);
    overlay.request(3, "session.end", { threadId: "thread-1", turnId: "turn-1" });
    // Turn ids are not reused, but nothing about the turn is kept after its end.
    overlay.request(4, "app.act", act());
    expect(overlay.isVisible).toBe(true);
  });
});

describe("window frame parsing", () => {
  it("reads the helper's window ids and CoreGraphics bounds", () => {
    expect(parseWindowNumber("w1234")).toBe(1234);
    expect(parseWindowNumber("a1")).toBeNull();
    expect(parseFrameOutput('{"X":10,"Y":-20,"Width":300,"Height":200}')).toEqual({
      x: 10,
      y: -20,
      width: 300,
      height: 200,
    });
    expect(parseFrameOutput("null")).toBeNull();
    expect(parseFrameOutput("garbage")).toBeNull();
  });
});
