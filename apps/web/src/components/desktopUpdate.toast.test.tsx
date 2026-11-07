import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
  closeToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast, close: testState.closeToast },
  stackedThreadToast: (options: unknown) => options,
}));

import {
  installDesktopUpdate,
  promptDesktopUpdateReadyOnce,
  showDesktopUpdateReadyPrompt,
} from "./desktopUpdate.toast";

type ClickableElement = ReactElement<{ readonly onClick?: () => void }>;

function findReleaseNotesLink(node: ReactNode): ClickableElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReleaseNotesLink(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (element.type === "button") return element as ClickableElement;
  if (typeof element.type === "function") {
    const render = element.type as (props: unknown) => ReactNode;
    return findReleaseNotesLink(render(element.props));
  }
  return findReleaseNotesLink(element.props.children);
}

type PromptToast = {
  title?: ReactNode;
  description?: ReactNode;
  actionProps?: { children?: ReactNode; onClick?: () => void };
};

function getToast(index = 0): PromptToast | undefined {
  return testState.addToast.mock.calls[index]?.[0] as PromptToast | undefined;
}

function getDescription(): ReactNode {
  return getToast()?.description ?? null;
}

function bridge(overrides: { openExternal?: () => Promise<boolean> } = {}) {
  return {
    openExternal: overrides.openExternal ?? vi.fn().mockResolvedValue(true),
    installUpdate: vi.fn().mockResolvedValue({
      accepted: true,
      completed: false,
      state: downloadedState(),
    }),
  };
}

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

describe("desktop update ready prompt", () => {
  beforeEach(() => {
    testState.addToast.mockReset().mockReturnValue("toast-id");
    testState.closeToast.mockReset();
  });

  it("prompts once per downloaded version", () => {
    const shell = bridge();
    promptDesktopUpdateReadyOnce(shell, downloadedState({ status: "downloading" }));
    expect(testState.addToast).not.toHaveBeenCalled();

    promptDesktopUpdateReadyOnce(shell, downloadedState({ downloadedVersion: "0.0.40" }));
    promptDesktopUpdateReadyOnce(shell, downloadedState({ downloadedVersion: "0.0.40" }));
    expect(testState.addToast).toHaveBeenCalledTimes(1);
    expect(getToast()?.title).toBe("Update 0.0.40 is ready");

    promptDesktopUpdateReadyOnce(shell, downloadedState({ downloadedVersion: "0.0.41" }));
    expect(testState.addToast).toHaveBeenCalledTimes(2);
  });

  it("installs from the Restart action", () => {
    const shell = bridge();
    showDesktopUpdateReadyPrompt(shell, downloadedState());
    const action = getToast()?.actionProps;
    expect(action?.children).toBe("Restart");

    action?.onClick?.();
    expect(testState.closeToast).toHaveBeenCalledWith("toast-id");
    expect(shell.installUpdate).toHaveBeenCalledTimes(1);
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

  it("opens the downloaded version's release notes", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    showDesktopUpdateReadyPrompt(bridge({ openExternal }), downloadedState());
    const link = findReleaseNotesLink(getDescription());
    link?.props.onClick?.();
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/devjiwonchoi/busyboy/releases/tag/v0.0.30",
      );
    });
    expect(testState.addToast).toHaveBeenCalledTimes(1);
  });

  it("falls back to the version the download was started for", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    // The `update-downloaded` event can land after the download RPC resolves.
    showDesktopUpdateReadyPrompt(
      bridge({ openExternal }),
      downloadedState({ downloadedVersion: null }),
    );
    findReleaseNotesLink(getDescription())?.props.onClick?.();

    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/devjiwonchoi/busyboy/releases/tag/v0.0.30",
      );
    });
  });

  it("omits the link when the updater reports no version at all", () => {
    showDesktopUpdateReadyPrompt(
      bridge(),
      downloadedState({ availableVersion: null, downloadedVersion: null }),
    );

    expect(findReleaseNotesLink(getDescription())).toBeNull();
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("open failed"))],
  ])("shows an error when opening release notes %s", async (_description, openExternal) => {
    showDesktopUpdateReadyPrompt(bridge({ openExternal }), downloadedState());
    findReleaseNotesLink(getDescription())?.props.onClick?.();

    await vi.waitFor(() => {
      expect(testState.addToast).toHaveBeenLastCalledWith({
        type: "error",
        title: "Unable to open release notes",
      });
    });
  });
});
