import {
  COMPUTER_USE_SETTINGS_URLS,
  DEFAULT_UNIFIED_SETTINGS,
  type ComputerUseSettingsStatus,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  COMPUTER_USE_UNSUPPORTED_MESSAGE,
  ComputerUseSettingsView,
  isComputerUseSupported,
  type ComputerUseSettingValues,
} from "./ComputerUseSettings";

// These unit tests walk the rendered element tree.
// Hook-free local parts are expanded in place;
// SettingsRow is kept and its title, description, status, control, and
// children are walked.
const EXPANDED = new Set(["PermissionRow", "GrantStatus"]);
const WALKED_PROPS = ["title", "description", "status", "control", "children"] as const;

type AnyElement = ReactElement<Record<string, unknown>>;

function walk(node: ReactNode, visit: (element: AnyElement) => void, texts: Array<string>): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, texts);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as AnyElement;
  const type = element.type as { name?: string } | string;
  if (typeof type === "function" && EXPANDED.has((type as { name: string }).name)) {
    walk((type as (props: unknown) => ReactNode)(element.props), visit, texts);
    return;
  }
  visit(element);
  for (const key of WALKED_PROPS) walk(element.props[key] as ReactNode, visit, texts);
}

const SETTINGS: ComputerUseSettingValues = {
  enableAgentComputerUse: DEFAULT_UNIFIED_SETTINGS.enableAgentComputerUse,
  computerUseAppGrants: DEFAULT_UNIFIED_SETTINGS.computerUseAppGrants,
  computerUseScreenshots: DEFAULT_UNIFIED_SETTINGS.computerUseScreenshots,
  computerUseExperimentalPointer: DEFAULT_UNIFIED_SETTINGS.computerUseExperimentalPointer,
};

const NOW = Date.parse("2026-11-05T00:00:00.000Z");

const grant = (appName: string, bundleId: string, project: string, expiresAt: string) => ({
  bundleId,
  appName,
  projectId: `project-${project.toLowerCase()}`,
  projectName: project,
  grantedAt: "2026-11-01T00:00:00.000Z",
  expiresAt,
});

const status = (
  permissions: ComputerUseSettingsStatus["permissions"],
  helper: ComputerUseSettingsStatus["helper"] = { state: "running" },
): ComputerUseSettingsStatus => ({
  enabled: true,
  available: true,
  helper,
  ...(permissions ? { permissions } : {}),
  settingsUrls: COMPUTER_USE_SETTINGS_URLS,
});

const GRANTED = status({
  accessibility: "granted",
  screenRecording: "granted",
  stopMonitor: "available",
});
const NOT_GRANTED = status(
  { accessibility: "not_granted", screenRecording: "not_granted", stopMonitor: "unavailable" },
  { state: "error", reason: "helper_crashed", detail: "the helper keeps crashing" },
);

function render(input: {
  canGrantOnThisDevice?: boolean;
  supported?: boolean | null;
  settings?: Partial<ComputerUseSettingValues>;
  now?: number;
  status?: ComputerUseSettingsStatus | null;
}) {
  const calls = {
    update: [] as Array<ServerSettingsPatch>,
    request: [] as Array<string>,
    open: [] as Array<string>,
    restart: 0,
  };
  const tree = ComputerUseSettingsView({
    canGrantOnThisDevice: input.canGrantOnThisDevice ?? true,
    supported: input.supported === undefined ? true : input.supported,
    settings: { ...SETTINGS, ...input.settings },
    status: input.status ?? null,
    onUpdate: (patch) => calls.update.push(patch),
    onRequestPermission: (kind) => calls.request.push(kind),
    onOpenSystemSettings: (url) => calls.open.push(url),
    onRestartHelper: () => {
      calls.restart += 1;
    },
    now: input.now ?? NOW,
  });
  const elements: Array<AnyElement> = [];
  const texts: Array<string> = [];
  walk(tree, (element) => elements.push(element), texts);
  const text = texts.join(" ");
  const buttons = (label: string) =>
    elements.filter(
      (element) =>
        element.type === Button &&
        (element.props.children === label || element.props["aria-label"] === label),
    ) as Array<ReactElement<{ onClick: () => void; disabled?: boolean }>>;
  const switchNamed = (label: string) =>
    elements.find((element) => element.type === Switch && element.props["aria-label"] === label) as
      | ReactElement<{
          checked: boolean;
          disabled?: boolean;
          onCheckedChange: (on: boolean) => void;
        }>
      | undefined;
  return { calls, text, buttons, switchNamed, elements };
}

describe("Computer Use settings section", () => {
  it("shows only the toggle while off, and turns it on", () => {
    const view = render({});
    const toggle = view.switchNamed("Let agents use Mac apps")!;
    expect(toggle.props.checked).toBe(false);
    expect(view.text).not.toContain("Accessibility");
    expect(view.buttons("Restart helper")).toHaveLength(0);

    toggle.props.onCheckedChange(true);
    expect(view.calls.update).toEqual([{ enableAgentComputerUse: true }]);
  });

  it("shows granted permissions and a running helper without access buttons", () => {
    const view = render({ settings: { enableAgentComputerUse: true }, status: GRANTED });
    expect(view.text).toContain("BusyBoy Computer Use");
    expect(view.text).toContain("Accessibility");
    expect(view.text).toContain("허용됨");
    expect(view.text).toContain("설정 완료 — 에이전트가 Mac 앱을 쓸 수 있어요");
    expect(view.buttons("열기")).toHaveLength(0);
    expect(view.text).toContain("Available");
    expect(view.text).toContain("Running");
    expect(view.buttons("Request access")).toHaveLength(0);
    const screenshots = view.switchNamed("Include screenshots")!;
    expect(screenshots.props.disabled).toBe(false);
    expect(screenshots.props.checked).toBe(true);
    expect(view.text).toContain("may stop working after macOS updates");
  });

  it("offers access requests and System Settings links when not granted", () => {
    const view = render({ settings: { enableAgentComputerUse: true }, status: NOT_GRANTED });
    expect(view.text).toContain("현재 단계");
    expect(view.text).toContain("대기 중");
    expect(view.text).toContain("Unavailable");
    expect(view.text).toContain("Error · the helper keeps crashing");

    const requests = view.buttons("Request access");
    expect(requests).toHaveLength(1);
    const open = view.buttons("열기");
    expect(open).toHaveLength(1);
    open[0]!.props.onClick();
    for (const button of requests) button.props.onClick();
    expect(view.calls.request).toEqual(["accessibility", "input_monitoring"]);

    for (const button of view.buttons("Open System Settings")) button.props.onClick();
    expect(view.calls.open).toEqual([
      COMPUTER_USE_SETTINGS_URLS.accessibility,
      COMPUTER_USE_SETTINGS_URLS.inputMonitoring,
    ]);

    // Screenshots need Screen Recording.
    const screenshots = view.switchNamed("Include screenshots")!;
    expect(screenshots.props.disabled).toBe(true);
    expect(screenshots.props.checked).toBe(false);
    expect(view.text).toContain("Needs Screen Recording");

    view.buttons("Restart helper")[0]!.props.onClick();
    expect(view.calls.restart).toBe(1);
  });

  it("shows the empty always-allowed list", () => {
    const view = render({ settings: { enableAgentComputerUse: true }, status: GRANTED });
    expect(view.text).toContain("Apps you always allow in a project will appear here.");
    expect(view.text).toContain("only in the project shown, for 30 days");
  });

  it("lists each grant with its project and expiry, hides expired ones, and removes one", () => {
    const textEditWebsite = grant(
      "TextEdit",
      "com.apple.TextEdit",
      "Website",
      "2026-12-01T00:00:00.000Z",
    );
    const textEditBackend = grant(
      "TextEdit",
      "com.apple.TextEdit",
      "Backend",
      "2026-12-01T00:00:00.000Z",
    );
    const expiredNotes = grant("Notes", "com.apple.Notes", "Website", "2026-11-01T00:00:00.000Z");
    const view = render({
      settings: {
        enableAgentComputerUse: true,
        computerUseAppGrants: [textEditWebsite, textEditBackend, expiredNotes],
      },
      status: GRANTED,
    });
    expect(view.text).toContain("TextEdit in Website");
    expect(view.text).toContain("TextEdit in Backend");
    expect(view.text).toContain("until");
    expect(view.text).not.toContain("Notes in Website");
    view.buttons("Remove TextEdit in Website")[0]!.props.onClick();
    // Removing one grant keeps the same app's grant in the other project and drops expired ones.
    expect(view.calls.update).toEqual([{ computerUseAppGrants: [textEditBackend] }]);
  });

  it("explains the platform limit and shows no controls when unsupported", () => {
    const view = render({ supported: false, settings: { enableAgentComputerUse: true } });
    expect(view.text).toContain(COMPUTER_USE_UNSUPPORTED_MESSAGE);
    expect(
      view.elements.filter((element) => element.type === Button || element.type === Switch),
    ).toEqual([]);
  });
});

describe("ComputerUseSettingsView before the first status", () => {
  it("shows a neutral loading state, not the full section", () => {
    const view = render({ supported: null, settings: { enableAgentComputerUse: true } });
    expect(view.text).toContain("Checking…");
    expect(view.text).not.toContain(COMPUTER_USE_UNSUPPORTED_MESSAGE);
    expect(view.text).not.toContain("손쉬운 사용(Accessibility)");
  });

  it("shows neutral steps without permission actions until permissions arrive", () => {
    for (const pending of [status(undefined, { state: "starting" })]) {
      const view = render({
        settings: { enableAgentComputerUse: true },
        status: pending,
      });
      expect(view.text).toContain("확인 중…");
      expect(view.text).toContain("손쉬운 사용(Accessibility)");
      expect(view.text).toContain("화면 기록(Screen Recording)");
      expect(view.buttons("열기")).toHaveLength(0);
    }
  });

  it("advances to Screen Recording after Accessibility is granted", () => {
    const view = render({
      settings: { enableAgentComputerUse: true },
      status: status({
        accessibility: "granted",
        screenRecording: "not_granted",
        stopMonitor: "available",
      }),
    });
    expect(view.text).toContain("허용됨");
    view.buttons("열기")[0]!.props.onClick();
    expect(view.calls.request).toEqual(["screen_recording"]);
    expect(view.calls.open).toEqual([COMPUTER_USE_SETTINGS_URLS.screenRecording]);
  });

  it("shows remote grant instructions and hides system permission actions on phones", () => {
    const view = render({
      settings: { enableAgentComputerUse: true },
      status: NOT_GRANTED,
      canGrantOnThisDevice: false,
    });
    expect(view.text.match(/Mac에서 허용 필요/g)).toHaveLength(2);
    expect(view.buttons("열기")).toHaveLength(0);
    expect(view.buttons("Request access")).toHaveLength(0);
    expect(view.buttons("Open System Settings")).toHaveLength(0);
  });
});

describe("isComputerUseSupported", () => {
  it("uses the backend report for browsers and requires a Mac for Electron", () => {
    // Unknown until the first status arrives.
    expect(isComputerUseSupported({ isElectron: true, platform: "MacIntel", status: null })).toBe(
      null,
    );
    expect(
      isComputerUseSupported({ isElectron: true, platform: "MacIntel", status: GRANTED }),
    ).toBe(true);
    expect(isComputerUseSupported({ isElectron: false, platform: "iPhone", status: null })).toBe(
      null,
    );
    expect(isComputerUseSupported({ isElectron: true, platform: "Win32", status: null })).toBe(
      false,
    );
    expect(isComputerUseSupported({ isElectron: false, platform: "iPhone", status: GRANTED })).toBe(
      true,
    );
    expect(
      isComputerUseSupported({
        isElectron: false,
        platform: "Linux",
        status: { ...GRANTED, available: false },
      }),
    ).toBe(false);
    expect(
      isComputerUseSupported({
        isElectron: false,
        platform: "iPhone",
        status: status(undefined, { state: "stopped", reason: "unsupported_platform" }),
      }),
    ).toBe(false);
    expect(
      isComputerUseSupported({
        isElectron: true,
        platform: "MacIntel",
        status: status(undefined, { state: "stopped", reason: "unsupported_platform" }),
      }),
    ).toBe(false);
    expect(
      isComputerUseSupported({
        isElectron: true,
        platform: "MacIntel",
        status: { ...GRANTED, available: false },
      }),
    ).toBe(false);
  });
});
