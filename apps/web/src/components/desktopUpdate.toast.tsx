import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReadyDescription,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
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

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
      type="button"
    >
      Read more
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
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

// `undefined` until the first prompt, so a versionless update still prompts once.
let promptedVersion: string | null | undefined;
let promptToastId: string | null = null;

/** Shows the restart prompt for the downloaded update, replacing any open one. */
export function showDesktopUpdateReadyPrompt(
  bridge: DesktopUpdateShell & Pick<DesktopBridge, "installUpdate">,
  state: DesktopUpdateState,
): void {
  const version = getDesktopUpdateDownloadedVersion(state);
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  promptedVersion = version;
  if (promptToastId !== null) toastManager.close(promptToastId);
  const toastId = toastManager.add(
    stackedThreadToast({
      type: "success",
      title: version ? `Update ${version} is ready` : "Update is ready",
      description: (
        <>
          {getDesktopUpdateReadyDescription(state)}
          {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={bridge} /> : null}
        </>
      ),
      timeout: 0,
      actionProps: {
        children: "Restart",
        onClick: () => {
          toastManager.close(toastId);
          void installDesktopUpdate(bridge);
        },
      },
    }),
  );
  promptToastId = toastId;
}

/** Prompts once per downloaded version per session. */
export function promptDesktopUpdateReadyOnce(
  bridge: DesktopUpdateShell & Pick<DesktopBridge, "installUpdate">,
  state: DesktopUpdateState,
): void {
  if (state.status !== "downloaded") return;
  if (getDesktopUpdateDownloadedVersion(state) === promptedVersion) return;
  showDesktopUpdateReadyPrompt(bridge, state);
}
