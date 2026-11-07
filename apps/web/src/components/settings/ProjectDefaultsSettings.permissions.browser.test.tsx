import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "global" },
    target: undefined,
    targets: [],
    environments: [],
    connectedEnvironments: [{}],
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: (() => null) as never,
  useUpdateScopedSettings: () => vi.fn(),
}));

import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const defaultPermissions = async (settings: UnifiedSettings) => {
  state.settings = settings;
  await act(async () => root.render(<ProjectDefaultsSettings category="general" />));
  return container.querySelector('[aria-label="Default permissions"]')?.textContent;
};

it("shows Auto as the default permissions on a fresh install", async () => {
  expect(await defaultPermissions(DEFAULT_UNIFIED_SETTINGS)).toContain("Auto");
});

it("keeps full access when the user chose it", async () => {
  expect(
    await defaultPermissions({ ...DEFAULT_UNIFIED_SETTINGS, defaultRuntimeMode: "full-access" }),
  ).toContain("Full access");
});
