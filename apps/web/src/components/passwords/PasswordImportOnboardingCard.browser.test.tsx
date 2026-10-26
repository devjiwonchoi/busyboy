import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { getSavedPasswordStatus } = vi.hoisted(() => ({
  getSavedPasswordStatus: vi.fn(),
}));

vi.mock(import("../preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: { getSavedPasswordStatus } as never,
}));

import { PasswordImportOnboardingCard } from "./PasswordImportOnboardingCard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (onImport = vi.fn()) =>
  act(async () => root.render(<PasswordImportOnboardingCard onImport={onImport} />));

describe("PasswordImportOnboardingCard", () => {
  it("offers an import until dismissed, and stays dismissed", async () => {
    getSavedPasswordStatus.mockResolvedValue({ count: 0, chromeSync: null });
    const onImport = vi.fn();
    await render(onImport);
    await vi.waitFor(() => expect(container.textContent).toContain("Import passwords"));

    const buttons = [...container.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "Import passwords")?.click();
    expect(onImport).toHaveBeenCalledTimes(1);

    await act(async () => {
      buttons.find((button) => button.textContent === "Not now")?.click();
    });
    expect(container.textContent).toBe("");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).toBe("");
  });

  it("stays hidden once passwords are saved", async () => {
    getSavedPasswordStatus.mockResolvedValue({ count: 3, chromeSync: null });
    await render();
    await vi.waitFor(() => expect(getSavedPasswordStatus).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
