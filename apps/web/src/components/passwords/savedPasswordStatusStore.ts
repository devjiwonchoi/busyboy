import type { SavedPasswordStatus } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { previewBridge } from "~/components/preview/previewBridge";

// One copy for the settings row, the import dialog and the browser's
// onboarding card, so an import in one place updates the others.
let status: SavedPasswordStatus | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const refreshSavedPasswordStatus = async (): Promise<void> => {
  if (!previewBridge) {
    return;
  }
  try {
    status = await previewBridge.getSavedPasswordStatus();
  } catch {
    status = null;
  }
  for (const listener of listeners) {
    listener();
  }
};

/** `null` until loaded, outside the desktop app, or when the vault can't be read. */
export function useSavedPasswordStatus(enabled: boolean): SavedPasswordStatus | null {
  useEffect(() => {
    if (enabled) {
      void refreshSavedPasswordStatus();
    }
  }, [enabled]);

  return useSyncExternalStore(subscribe, () => status);
}
