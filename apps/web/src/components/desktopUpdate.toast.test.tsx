import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
  stackedThreadToast: (options: unknown) => options,
}));

import { installDesktopUpdate, openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.30",
    downloadedVersion: "0.0.30",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: 100,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

describe("desktop update actions", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
  });

  it("reports an install the updater did not accept", async () => {
    const reportError = vi.fn();
    const installed = await installDesktopUpdate(
      {
        installUpdate: vi.fn().mockResolvedValue({
          accepted: false,
          completed: false,
          state: downloadedState({ status: "available", message: null }),
        }),
      },
      reportError,
    );
    expect(installed).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      "Could not install update",
      "The update is not ready to install yet.",
    );
  });

  it("opens release notes", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    await openDesktopUpdateReleaseNotes({ openExternal }, "https://example.com/v0.0.30");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/v0.0.30");
    expect(testState.addToast).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("open failed"))],
  ])("shows an error when opening release notes %s", async (_description, openExternal) => {
    await openDesktopUpdateReleaseNotes({ openExternal }, "https://example.com/v0.0.30");
    expect(testState.addToast).toHaveBeenLastCalledWith({
      type: "error",
      title: "Unable to open release notes",
    });
  });
});
