import type * as Electron from "electron";

/**
 * Windows that belong to a feature, not to the app's UI, such as the
 * computer-use overlay. The app's window list skips them, so Dock activate,
 * deep links, IPC broadcasts, and theme sync never pick one by mistake.
 */
const auxiliaryWindows = new WeakSet<Electron.BrowserWindow>();

export const markAuxiliaryWindow = (window: Electron.BrowserWindow): void => {
  auxiliaryWindows.add(window);
};

export const isAuxiliaryWindow = (window: Electron.BrowserWindow): boolean =>
  auxiliaryWindows.has(window);
