import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_HISTORY_URL = "https://github.com/devjiwonchoi/busyboy/releases";
const DESKTOP_RELEASE_TAG_URL = `${DESKTOP_RELEASE_HISTORY_URL}/tag`;

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(): string {
  return DESKTOP_RELEASE_HISTORY_URL;
}

/** The download runs automatically as soon as a check finds an update. */
export function isDesktopUpdatePreparing(state: DesktopUpdateState | null): boolean {
  if (!state) return false;
  return (
    state.status === "downloading" ||
    (state.status === "available" && state.errorContext !== "download")
  );
}

function hasFailedDownload(state: DesktopUpdateState): boolean {
  return (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion !== null
  );
}

/** "download" only retries a failed download; a successful check downloads on its own. */
export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  return hasFailedDownload(state) ? "download" : "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return isDesktopUpdatePreparing(state);
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  const prefix =
    "This Mac has Apple Silicon, but BusyBoy is still running the Intel build under Rosetta.";
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "install") {
    return `${prefix} Restart to install the downloaded Apple Silicon build.`;
  }
  if (action === "download") {
    return `${prefix} Retry the update download to switch to the native Apple Silicon build.`;
  }
  if (isDesktopUpdatePreparing(state)) {
    return `${prefix} The native Apple Silicon build is downloading now.`;
  }
  return `${prefix} The next app update will replace it with the native Apple Silicon build.`;
}

function getDesktopUpdateReadyTooltip(state: DesktopUpdateState): string {
  const version = getDesktopUpdateDownloadedVersion(state);
  const label = version ? `Update ${version} ready` : "Update ready";
  return state.localApp
    ? `${label} — restart to update`
    : `${label} — restart to update, or it installs when you quit`;
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    state.status === "downloaded" &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `Update ${state.notAppliedVersion} did not apply. Click to retry.`;
  }
  if (hasFailedDownload(state)) {
    return "Download failed — click to retry";
  }
  if (isDesktopUpdatePreparing(state)) {
    const progress =
      state.status === "downloading" && typeof state.downloadPercent === "number"
        ? ` (${Math.floor(state.downloadPercent)}%)`
        : "";
    return `Downloading update${progress}…`;
  }
  if (state.status === "downloaded") {
    return getDesktopUpdateReadyTooltip(state);
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return getDesktopUpdateReadyTooltip(state);
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

/** Body of the "update is ready" prompt. */
export function getDesktopUpdateReadyDescription(
  state: Pick<DesktopUpdateState, "localApp">,
): string {
  return state.localApp
    ? "Restart to install it now. Otherwise it installs the next time BusyBoy restarts."
    : "Restart to install it now. Otherwise it installs when you quit BusyBoy.";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
