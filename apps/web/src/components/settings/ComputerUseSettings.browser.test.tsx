import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { state, getPermissions, updateSettings } = vi.hoisted(() => ({
  state: {
    permissions: { available: true, accessibility: true, screenRecording: false },
    settings: {
      computerUseKeepDisplayAwake: false,
      computerUseAllowedApps: ["com.apple.TextEdit", "com.apple.Notes"],
    },
  },
  getPermissions: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => getPermissions) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => ({ environmentId: "env" })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettings: ((select: (settings: typeof state.settings) => unknown) =>
    select(state.settings)) as never,
  useUpdatePrimarySettings: (() => updateSettings) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => {
  const actual = await original();
  // The real row reads the settings scope and write permissions, which this test does not need.
  return {
    ...actual,
    SettingsRow: (({ title, description, status, control, children }) => (
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        <p>{status}</p>
        {control}
        {children}
      </div>
    )) as typeof actual.SettingsRow,
  };
});

import { ComputerUseSettings } from "./ComputerUseSettings";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getPermissions.mockImplementation(async () => ({
    _tag: "Success",
    value: state.permissions,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  getPermissions.mockReset();
  updateSettings.mockReset();
  vi.unstubAllGlobals();
});

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  );

describe("ComputerUseSettings", () => {
  it("shows the missing permission, asks macOS for it, and picks up the grant on return", async () => {
    await act(async () => root.render(<ComputerUseSettings />));
    expect(container.textContent).toContain("Accessibility: On · Screen Recording: Off");
    expect(container.textContent).toContain("Full access mode can run any program");
    expect(getPermissions).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { request: false },
    });

    await userEvent.click(button("Ask macOS")!);
    expect(getPermissions).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { request: true },
    });

    // The user turns it on in System Settings and comes back.
    state.permissions = { available: true, accessibility: true, screenRecording: true };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toContain("Accessibility: On · Screen Recording: On");
    expect(button("Ask macOS")).toBeUndefined();
  });

  it("removes an always-allowed app so agents ask for it again", async () => {
    await act(async () => root.render(<ComputerUseSettings />));
    await userEvent.click(button("Remove com.apple.TextEdit")!);
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      computerUseAllowedApps: ["com.apple.Notes"],
    });
  });

  it("turns on keeping the display awake", async () => {
    await act(async () => root.render(<ComputerUseSettings />));
    const toggle = container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Keep display awake for computer use"]',
    )!;
    await act(async () => toggle.click());
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ computerUseKeepDisplayAwake: true });
  });

  it("says computer use is unavailable when the backend cannot run it", async () => {
    state.permissions = { available: false, accessibility: false, screenRecording: false };
    await act(async () => root.render(<ComputerUseSettings />));
    expect(container.textContent).toContain("Only available in the Busyboy desktop app on macOS.");
    state.permissions = { available: true, accessibility: true, screenRecording: false };
  });
});
