import "~/index.css";

import {
  COMPUTER_USE_SETTINGS_URLS,
  DEFAULT_UNIFIED_SETTINGS,
  type ComputerUseSettingsStatus,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ComputerUseSettingsView } from "./ComputerUseSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

// Re-rendering status simulates the existing poll delivering each Mac grant.
async function permissionJourney(canGrantOnThisDevice: boolean) {
  const onUpdate = vi.fn();
  const onRequestPermission = vi.fn();
  const onOpenSystemSettings = vi.fn();
  const onRestartHelper = vi.fn();
  const render = async (
    enabled: boolean,
    accessibility: "granted" | "not_granted",
    screenRecording: "granted" | "not_granted",
  ) => {
    const status: ComputerUseSettingsStatus = {
      available: true,
      enabled,
      helper: { state: "running" },
      permissions: { accessibility, screenRecording, stopMonitor: "unavailable" },
      settingsUrls: COMPUTER_USE_SETTINGS_URLS,
    };
    await act(() =>
      root.render(
        <ComputerUseSettingsView
          supported
          canGrantOnThisDevice={canGrantOnThisDevice}
          settings={{ ...DEFAULT_UNIFIED_SETTINGS, enableAgentComputerUse: enabled }}
          status={status}
          onUpdate={onUpdate}
          onRequestPermission={onRequestPermission}
          onOpenSystemSettings={onOpenSystemSettings}
          onRestartHelper={onRestartHelper}
        />,
      ),
    );
  };
  const guide = page.getByRole("list", { name: "처음 설정" });
  const accessibility = guide.getByRole("listitem").filter({ hasText: "손쉬운 사용" });
  const screenRecording = guide.getByRole("listitem").filter({ hasText: "화면 기록" });
  const open = page.getByRole("button", { name: "열기", exact: true });

  await render(false, "not_granted", "not_granted");
  expect(guide.query()).toBeNull();
  await page.getByRole("switch", { name: "Let agents use Mac apps" }).click();
  expect(onUpdate).toHaveBeenCalledWith({ enableAgentComputerUse: true });

  await render(true, "not_granted", "not_granted");
  await expect.element(accessibility).toHaveAttribute("aria-current", "step");
  await expect.element(accessibility.getByText("현재 단계")).toBeVisible();
  await expect.element(screenRecording.getByText("대기 중")).toBeVisible();
  if (canGrantOnThisDevice) {
    await accessibility.getByRole("button", { name: "열기" }).click();
    expect(onRequestPermission).toHaveBeenCalledWith("accessibility");
    expect(onOpenSystemSettings).toHaveBeenCalledWith(COMPUTER_USE_SETTINGS_URLS.accessibility);
    expect(onRequestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenSystemSettings.mock.invocationCallOrder[0]!,
    );
  } else {
    expect(open.query()).toBeNull();
    await expect.element(accessibility.getByText("Mac에서 허용 필요")).toBeVisible();
    await expect.element(screenRecording.getByText("Mac에서 허용 필요")).toBeVisible();
    expect(page.getByRole("button", { name: "Request access" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Open System Settings" }).query()).toBeNull();
  }

  // Phone steps stack and the guide stays within the viewport.
  const first = accessibility.element().getBoundingClientRect();
  const second = screenRecording.element().getBoundingClientRect();
  expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

  await render(true, "granted", "not_granted");
  await expect.element(accessibility.getByText("허용됨")).toBeVisible();
  await expect.element(screenRecording).toHaveAttribute("aria-current", "step");
  if (canGrantOnThisDevice) {
    await screenRecording.getByRole("button", { name: "열기" }).click();
    expect(onRequestPermission).toHaveBeenLastCalledWith("screen_recording");
    expect(onOpenSystemSettings).toHaveBeenLastCalledWith(
      COMPUTER_USE_SETTINGS_URLS.screenRecording,
    );
  } else {
    expect(open.query()).toBeNull();
    await expect.element(screenRecording.getByText("Mac에서 허용 필요")).toBeVisible();
  }

  await render(true, "granted", "granted");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("설정 완료 — 에이전트가 Mac 앱을 쓸 수 있어요");
  await expect.element(screenRecording.getByText("허용됨")).toBeVisible();
  expect(open.query()).toBeNull();
  if (!canGrantOnThisDevice) {
    expect(onRequestPermission).toHaveBeenCalledTimes(0);
    expect(onOpenSystemSettings).toHaveBeenCalledTimes(0);
  }
}

describe("Computer Use setup on desktop", () => {
  it("enables Mac app access and guides both permission grants in order", async () => {
    await page.viewport(1280, 800);
    await permissionJourney(true);
  });
});

describe("Computer Use setup on phone", () => {
  it("enables Mac app access and follows grants made on the Mac without local actions", async () => {
    await page.viewport(390, 844);
    await permissionJourney(false);
  });
});
