import { contextBridge, ipcRenderer } from "electron";

import { installPasswordPreload } from "./preview/BrowserPasswords/PasswordPreload.ts";
import {
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
  PASSWORD_BRIDGE_ARGUMENT,
} from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import { installPreviewMainWorld } from "./preview/PreviewMainWorld.generated.ts";

// This preload runs isolated from the previewed page (contextIsolation), so the page never sees
// ipcRenderer. The two pieces that must live in the page's own world are copied there with
// contextBridge.executeInMainWorld and get only what they need: the picker's React lookup gets
// nothing, and the passkey shim gets one function that starts a ceremony for the page's origin.
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
  // Installed at document start, before the page's React, so react-grab's DevTools hook sees it.
  contextBridge.executeInMainWorld({ func: installPreviewMainWorld });
  // A conditional require keeps the picker's top-level side effects out of subframes.
  require("./preview/PickPreload.ts");
  if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
    contextBridge.executeInMainWorld({
      func: installPasskeyBridge,
      args: [
        (channel: string, publicKey: unknown) =>
          channel === PASSKEY_CREATE_CHANNEL || channel === PASSKEY_GET_CHANNEL
            ? ipcRenderer.invoke(channel, publicKey)
            : Promise.reject(new Error("Unknown passkey channel.")),
        { create: PASSKEY_CREATE_CHANNEL, get: PASSKEY_GET_CHANNEL },
      ],
    });
  }
}
