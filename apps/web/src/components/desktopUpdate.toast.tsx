import type { DesktopBridge } from "@t3tools/contracts";

import { getDesktopUpdateActionError } from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

export async function openDesktopUpdateReleaseNotes(
  shell: DesktopUpdateShell | undefined,
  releaseUrl: string,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {}
  toastManager.add({ type: "error", title: "Unable to open release notes" });
}

export type ReportDesktopUpdateError = (title: string, description: string) => void;

const toastUpdateError: ReportDesktopUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

/** Installs the downloaded update, which restarts the app. Resolves false on failure. */
export async function installDesktopUpdate(
  bridge: Pick<DesktopBridge, "installUpdate">,
  reportError: ReportDesktopUpdateError = toastUpdateError,
): Promise<boolean> {
  try {
    const result = await bridge.installUpdate();
    if (!result.accepted) {
      reportError(
        "Could not install update",
        result.state.message ?? "The update is not ready to install yet.",
      );
      return false;
    }
    const actionError = getDesktopUpdateActionError(result);
    if (!actionError) return true;
    reportError("Could not install update", actionError);
    return false;
  } catch (error) {
    reportError(
      "Could not install update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}
