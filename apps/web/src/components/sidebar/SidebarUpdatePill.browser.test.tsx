import { RegistryContext } from "@effect/atom-react";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const bridge = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>();
  const mock = {
    listeners,
    current: null as unknown,
    getUpdateState: async () => mock.current,
    onUpdateState: (listener: (state: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkForUpdate: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    openExternal: vi.fn(async () => true),
  };
  // `isElectron` is read when ~/env loads, so the bridge must exist first.
  (window as unknown as { desktopBridge: unknown }).desktopBridge = mock;
  return mock;
});

vi.mock(import("~/hooks/useThreadRouteTarget"), async (original) => ({
  ...(await original()),
  useThreadRouteTarget: (() => null) as never,
}));
vi.mock(import("./useUpdateEverything"), async (original) => ({
  ...(await original()),
  useUpdateEverything: (() => ({
    hasUpdates: false,
    summary: "",
    lines: [],
    restarts: [],
    skipped: [],
    run: async () => {},
  })) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { ToastProvider } from "../ui/toast";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { DesktopUpdateLaunchNotice } from "./updateEverythingRun";

function updateState(overrides: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  };
}

async function emit(state: DesktopUpdateState) {
  bridge.current = state;
  await act(async () => {
    for (const listener of bridge.listeners) listener(state);
  });
}

function actionResult(state: DesktopUpdateState): DesktopUpdateActionResult {
  return { accepted: true, completed: false, state };
}

const updateButton = (name: string | RegExp) => page.getByRole("button", { name });

let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.downloadUpdate.mockReset();
  bridge.installUpdate.mockReset();
  bridge.current = updateState({ status: "up-to-date" });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ToastProvider>
          <ul>
            <SidebarUpdatePill />
          </ul>
          <DesktopUpdateLaunchNotice />
        </ToastProvider>
      </RegistryContext.Provider>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("desktop app update", () => {
  it("downloads on its own, then prompts to restart", async () => {
    bridge.installUpdate.mockResolvedValue(
      actionResult(updateState({ status: "downloaded", downloadedVersion: "0.0.30" })),
    );

    await emit(updateState({ status: "available", availableVersion: "0.0.30" }));
    await expect.element(updateButton("Downloading update…")).toBeInTheDocument();

    await emit(
      updateState({ status: "downloading", availableVersion: "0.0.30", downloadPercent: 42 }),
    );
    await expect.element(updateButton("Downloading update (42%)…")).toBeInTheDocument();
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();

    const ready = updateState({
      status: "downloaded",
      availableVersion: "0.0.30",
      downloadedVersion: "0.0.30",
      downloadPercent: 100,
    });
    await emit(ready);
    await expect.element(page.getByText("Update 0.0.30 is ready")).toBeVisible();
    await expect
      .element(page.getByText(/Otherwise it installs when you quit BusyBoy/))
      .toBeVisible();

    // Dismissing keeps the update button in its ready state.
    await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
    await expect.element(page.getByText("Update 0.0.30 is ready")).not.toBeInTheDocument();
    const readyButton = updateButton(
      "Update 0.0.30 ready — restart to update, or it installs when you quit",
    );
    await expect.element(readyButton).toBeInTheDocument();

    // The same state again does not re-prompt.
    await emit({ ...ready });
    expect(page.getByText("Update 0.0.30 is ready").query()).toBeNull();

    // The update button reopens the prompt.
    await userEvent.click(readyButton);
    await expect.element(page.getByText("Update 0.0.30 is ready")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Restart" }));
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
  });

  it("offers a retry when the download fails", async () => {
    const failed = updateState({
      status: "available",
      availableVersion: "0.0.31",
      errorContext: "download",
      canRetry: true,
      message: "Signature verification failed",
    });
    bridge.downloadUpdate.mockResolvedValue(
      actionResult(updateState({ status: "downloading", availableVersion: "0.0.31" })),
    );

    await emit(failed);
    const retry = updateButton("Download failed — click to retry");
    await expect.element(retry).toBeInTheDocument();

    await userEvent.click(retry);
    await vi.waitFor(() => expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1));
  });
});
