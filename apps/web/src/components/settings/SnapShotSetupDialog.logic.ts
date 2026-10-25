import type { DesktopSnapShotState } from "@busyboy/contracts";

export type CaptureSetupStep = "access" | "shortcut";

export function captureSetupAccessReady(state: DesktopSnapShotState): boolean {
  return state.mode !== "unavailable" && !state.message;
}

export function captureSetupMacPermissionsReady(
  state: DesktopSnapShotState,
  includeAccessibility: boolean,
): boolean {
  const permissions = state.macPermissions;
  if (!permissions) return true;
  return permissions.screenRecording && (!includeAccessibility || permissions.accessibility);
}

export function captureSetupCheckMessage(state: DesktopSnapShotState): string {
  if (state.message) return "Still unable to check access. See Advanced for help.";
  return captureSetupAccessReady(state)
    ? "Ready. Continue to choose your shortcut."
    : "Not ready yet. Finish the step above.";
}

export function captureSetupShortcutReady(state: DesktopSnapShotState, unsaved: boolean): boolean {
  if (unsaved || !captureSetupAccessReady(state)) return false;
  return state.shortcutRegistered || Boolean(state.shortcutPending);
}

export function captureSetupInitialStep(
  state: DesktopSnapShotState,
  requested: CaptureSetupStep | "resume" = "resume",
): CaptureSetupStep {
  if (!captureSetupAccessReady(state)) return "access";
  if (requested === "resume") {
    // A disabled native backend hasn't checked system permissions yet.
    if (state.mode === "direct" && !state.shortcutRegistered) return "access";
    return "shortcut";
  }
  return requested;
}

export function captureSetupShouldDisableOnClose(wasEnabled: boolean, completed: boolean): boolean {
  return !wasEnabled && !completed;
}
