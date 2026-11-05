/**
 * - `contextIsolation=true`: the guest preload (picker, passwords, passkeys) runs in its own
 *   JavaScript world, so a previewed page never reaches its `ipcRenderer`. The few pieces that
 *   must touch the page's world are copied there with `contextBridge.executeInMainWorld`.
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled, so the preload never has Node.
 * - `nodeIntegration=false`: defense in depth; the page never gets Node.
 *
 * `DesktopWindow`'s `will-attach-webview` handler enforces the same values in the main process,
 * so a renderer bug that drops this string still cannot weaken a guest.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false";
