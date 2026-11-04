import { ipcRenderer } from "electron";

import { installPasswordPreload } from "./preview/BrowserPasswords/PasswordPreload.ts";
import { PASSKEY_BRIDGE_ARGUMENT, PASSWORD_BRIDGE_ARGUMENT } from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
// Persistent profiles also run this preload in subframes, which get only password support.
if (process.argv.includes(PASSWORD_BRIDGE_ARGUMENT)) {
  installPasswordPreload({
    window,
    ipc: {
      send: (channel, payload) => ipcRenderer.send(channel, payload),
      on: (channel, listener) => ipcRenderer.on(channel, (_event, payload) => listener(payload)),
    },
  });
}

const isMainFrame =
  (process as { readonly isMainFrame?: boolean }).isMainFrame ?? window.top === window;

if (isMainFrame) {
  // A conditional require keeps the picker's top-level side effects out of subframes.
  require("./preview/PickPreload.ts");
  if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
    installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
  }
}
