// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native key poller with Node.

import * as NodeChildProcess from "node:child_process";

// Polls the hardware Escape key (virtual key 53) instead of registering a
// shortcut, which would take Escape away from every other app while an agent
// works. Hardware state also ignores the Escape the agent itself sends to an
// app, so the agent cannot stop itself. Go background-only first so the
// poller never gets a Dock tile.
const POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run() {
  const HID_SYSTEM_STATE = 1;
  const ESCAPE = 53;
  let down = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const pressed = $.CGEventSourceKeyState(HID_SYSTEM_STATE, ESCAPE);
    if (pressed && !down) console.log("escape");
    down = pressed;
    delay(0.05);
  }
  return "orphaned";
}`;

/** Starts the poller and resolves once it runs, with a function that stops it. */
export function startEscWatcher(
  onEscape: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", POLLER_SCRIPT],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let buffered = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      poller.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      stop();
      if (settled) {
        onFailure(error);
        return;
      }
      settled = true;
      reject(error);
    };

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = line.trim();
        if (message === "ready" && !settled) {
          settled = true;
          resolve(stop);
          continue;
        }
        if (message !== "escape" || !settled || stopped) continue;
        try {
          onEscape();
        } catch {}
      }
    });
    poller.once("error", fail);
    poller.once("exit", (code) => fail(new Error(`Escape watcher exited with code ${code}`)));
  });
}
