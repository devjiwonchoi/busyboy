// @effect-diagnostics globalTimers:off -- An Electron utility process; the poll runs outside any Effect fiber.
import { SNAP_SHOT_MODIFIERS, type SnapShotModifier } from "@t3tools/contracts";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";
import { WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS } from "./snapShot.ts";

const POLL_INTERVAL_MS = 50;

// Runs as an Electron utility process; `process.parentPort` is its channel to the app.
const parentPort = (process as { readonly parentPort?: { postMessage(message: unknown): void } })
  .parentPort;

const requested = process.argv.find((arg) =>
  (SNAP_SHOT_MODIFIERS as readonly string[]).includes(arg),
);
if (requested === undefined) {
  process.exit(1);
}
const [left, right] = WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS[requested as SnapShotModifier];

async function poll() {
  const api = await loadWindowsForegroundApi();
  let active = false;
  parentPort?.postMessage("ready");
  const timer = setInterval(() => {
    const pressed = api.isKeyDown(left) && api.isKeyDown(right);
    if (pressed && !active) {
      try {
        parentPort?.postMessage("trigger");
      } catch {}
    }
    active = pressed;
  }, POLL_INTERVAL_MS);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
}

void poll().catch(() => process.exit(1));
