import { assert, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@busyboy/contracts";

import {
  createRecordingRequestTracker,
  snapShotStatus,
  snapShotShortcutStatus,
  snapShotUnavailableMessage,
  snapShotSoundPatch,
  snapShotSetupButtonLabel,
  snapShotSetupComplete,
  snapShotDescription,
} from "./SnapShotSettings.logic";

const direct: DesktopSnapShotState = {
  mode: "direct",
  shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
  shortcutRegistered: false,
  shortcutMessage: null,
  message: null,
};

it.each([
  ["off", { snapShotPlaySound: false }],
  ["soft-pop", { snapShotPlaySound: true, snapShotSound: "soft-pop" }],
  ["camera-shutter", { snapShotPlaySound: true, snapShotSound: "camera-shutter" }],
] as const)("maps %s to compatible capture settings", (sound, patch) => {
  expect(snapShotSoundPatch(sound)).toEqual(patch);
});

it("ignores a stale request after a newer request starts", () => {
  const requests = createRecordingRequestTracker();
  const firstRequest = requests.tryBegin();
  assert(firstRequest);

  requests.clear();
  const secondRequest = requests.tryBegin();
  assert(secondRequest);

  expect(requests.owns(firstRequest)).toBe(false);
  expect(requests.owns(secondRequest)).toBe(true);
  expect(requests.tryBegin()).toBeNull();
});

it("reports unavailable capture support without browser globals", () => {
  expect(snapShotUnavailableMessage(false)).toBe("Only available in the desktop app.");
});

it("keeps unavailable capture distinct from the opt-in setup prompt", () => {
  const state: DesktopSnapShotState = {
    ...direct,
    mode: "unavailable",
    message: "SnapShots are not supported on this platform.",
  };
  expect(snapShotStatus(state, false)).toBe("SnapShots are not supported on this platform.");
  expect(snapShotStatus(direct, false)).toBe("Turn this on to set up snapshots.");
  expect(snapShotStatus({ ...direct, message: "Capture needs attention" }, true)).toBe(
    "Capture needs attention",
  );
});

it("describes window capture", () => {
  expect(snapShotDescription()).toBe("Capture a window and attach it to your current draft.");
});

it("reports pending, failed, and registered shortcuts", () => {
  const pending = { ...direct, shortcutPending: true };
  expect(snapShotStatus(pending, true)).toBe("Waiting for shortcut permission");
  expect(snapShotShortcutStatus(pending)).toContain("Approve the shortcut permission prompt");
  const failed = { ...direct, shortcutMessage: "This shortcut is already used." };
  expect(snapShotStatus(failed, true)).toBe("Finish shortcut setup");
  expect(snapShotShortcutStatus(failed)).toBe("This shortcut is already used.");
  const registered = { ...direct, shortcutRegistered: true };
  expect(snapShotStatus(registered, true)).toBe("Shortcut saved");
  expect(snapShotStatus({ ...registered, shortcutVerified: true }, true)).toBe("Ready to capture");
  expect(snapShotShortcutStatus(registered)).toBe("Shortcut saved.");
  expect(snapShotSetupButtonLabel(registered)).toBe("Manage capture");
  expect(snapShotSetupButtonLabel(null)).toBe("Continue setup");
});

it("hides macOS setup only while permissions and the shortcut are all in place", () => {
  const ready: DesktopSnapShotState = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
    macPermissions: { screenRecording: true, accessibility: true },
  };
  expect(snapShotSetupComplete(ready, true)).toBe(true);
  expect(snapShotSetupComplete({ ...ready, macPermissions: undefined }, true)).toBe(false);
  expect(snapShotSetupComplete({ ...ready, shortcutRegistered: false }, true)).toBe(false);
  const revoked = {
    ...ready,
    macPermissions: { screenRecording: true, accessibility: false },
    message: "Allow Accessibility in System Settings, then restart Busyboy.",
  };
  expect(snapShotSetupComplete(revoked, true)).toBe(false);
  expect(snapShotStatus(revoked, true)).toBe("Capture needs attention");
  expect(snapShotSetupButtonLabel(revoked)).toBe("Continue setup");
  expect(snapShotSetupComplete({ ...revoked, message: null }, false)).toBe(true);
  expect(
    snapShotSetupComplete(
      { ...ready, windows: true, macPermissions: undefined, shortcutRegistered: false },
      true,
    ),
  ).toBe(true);
});
