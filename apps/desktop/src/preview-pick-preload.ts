import { ipcRenderer } from "electron";

import { PASSKEY_BRIDGE_ARGUMENT, PASSWORD_FILL_CHANNEL } from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import { installPasswordAutofill } from "./preview/PasswordAutofill.ts";
import "./preview/PickPreload.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}

installPasswordAutofill((request) => ipcRenderer.invoke(PASSWORD_FILL_CHANNEL, request));
