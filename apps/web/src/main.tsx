import React from "react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import { prepareProviderAuthDelivery } from "./providerAuthDelivery";
import { isElectron } from "./env";

import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

prepareProviderAuthDelivery();

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html.
let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

export const startup = router
  .load()
  .then(() => {
    if (reloadScheduled) {
      return null;
    }
    if (!chunkLoadFailed) {
      clearChunkReloadGuard();
    }
    return <React.StrictMode>{app}</React.StrictMode>;
  })
  .catch((error: unknown) => {
    if (reloadScheduled) {
      return null;
    }
    throw error;
  });

// Next owns the React root; Vite's bootstrap can render the same prepared tree.
export default function Main() {
  return React.use(startup);
}
