/**
 * Packages compiled into the browser guest preload. A sandboxed preload can
 * only `require("electron")` at runtime, so any other package it imports must
 * be bundled, and should stay small because it loads into every page.
 */
export const PREVIEW_PRELOAD_BUNDLED_PACKAGES: ReadonlyArray<string> = ["react-grab"];

export const isBundledIntoPreviewPreload = (id: string): boolean =>
  PREVIEW_PRELOAD_BUNDLED_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`));
