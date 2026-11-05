// @effect-diagnostics globalConsole:off -- Runs before any Effect runtime exists.
// A packaged BusyBoy holds the user's macOS permissions and its keychain items, so
// another program must not be able to open a debugger into it. Chromium honors
// --remote-debugging-* whatever the Electron fuses say, so refuse those switches
// (and the Node inspector ones, which the release fuses already ignore) before any
// app code loads.
const DEBUGGING_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
  "inspect-port",
];
const { app } = require("electron") as typeof import("electron");
if (app.isPackaged && DEBUGGING_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) {
  console.error("BusyBoy does not start with debugging switches.");
  app.exit(1);
} else {
  // Enables the compile cache before the main bundle loads, so the cache also
  // covers main.cjs itself.
  require("./compileCache.cjs");
  require("./main.cjs");
}
