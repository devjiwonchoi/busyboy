import type { WebPreferences } from "electron";

import { PASSKEY_BRIDGE_ARGUMENT, PASSWORD_BRIDGE_ARGUMENT } from "./GuestProtocol.ts";

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

/**
 * Sets a preview guest's preferences in the main process (`will-attach-webview`), whatever the
 * renderer's <webview> tag asked for.
 */
export function hardenPreviewWebPreferences(
  webPreferences: WebPreferences,
  input: {
    readonly partition: string;
    readonly preloadPath: string;
    readonly passkeyBridge: boolean;
  },
): void {
  // Pinned, so only BusyBoy's own guest preload ever runs next to a previewed page.
  webPreferences.preload = input.preloadPath;
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  // Isolated, so a previewed page never shares a world with the preload's ipcRenderer.
  webPreferences.contextIsolation = true;
  // Persistent profiles run the preload in subframes too, so a login form
  // inside a cross-origin iframe is scoped to that iframe's own origin. The
  // sandbox still applies; the entry runs only the password module there.
  // Incognito partitions (no `persist:` prefix) never get the password module.
  const savesPasswords = input.partition.startsWith("persist:");
  webPreferences.nodeIntegrationInSubFrames = savesPasswords;
  webPreferences.disableHtmlFullscreenWindowResize = true;
  const additionalArguments = [...(webPreferences.additionalArguments ?? [])];
  if (input.passkeyBridge) additionalArguments.push(PASSKEY_BRIDGE_ARGUMENT);
  if (savesPasswords) additionalArguments.push(PASSWORD_BRIDGE_ARGUMENT);
  webPreferences.additionalArguments = additionalArguments;
}
