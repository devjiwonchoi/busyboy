import { ipcRenderer } from "electron";
import { COMPUTER_USE_OVERLAY_CHANNEL } from "./ipc/channels.ts";

window.addEventListener("DOMContentLoaded", () => {
  document
    .getElementById("stop")
    ?.addEventListener("click", () => ipcRenderer.send(COMPUTER_USE_OVERLAY_CHANNEL, "stop"));
});
