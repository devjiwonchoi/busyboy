// @vitest-environment jsdom
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectTaskStepModels,
  ProviderInstanceId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Settings rows render as plain buttons so the test reads what the user sees and taps.
vi.mock("./components/SettingsChoiceRow", () => ({
  SettingsChoiceRow: (props: {
    label: string;
    description?: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
      {props.description ? ` — ${props.description}` : ""}
    </button>
  ),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
      {props.footer ? <p>{props.footer}</p> : null}
    </section>
  ),
}));

import type { ModelOption } from "../../lib/modelOptions";
import { StepModelsSettings } from "./components/StepModelsSettings";

const level = (id: string, levels: ReadonlyArray<[string, string]>) => ({
  optionDescriptors: [
    {
      id,
      label: "Reasoning",
      type: "select" as const,
      options: levels.map(([value, label]) => ({ id: value, label })),
    },
  ],
});

const option = (
  instanceId: string,
  model: string,
  label: string,
  capabilities: ModelOption["capabilities"],
): ModelOption =>
  ({
    key: `${instanceId}:${model}`,
    label,
    subtitle: "",
    providerKey: instanceId,
    providerLabel: instanceId === "codex" ? "Codex" : "Claude",
    providerDriver: instanceId,
    isDefault: false,
    isLegacy: false,
    capabilities,
    selection: { instanceId: ProviderInstanceId.make(instanceId), model },
  }) as unknown as ModelOption;

const MODELS = [
  option(
    "claudeAgent",
    "claude-opus-5-5",
    "Claude Opus 5.5",
    level("effort", [
      ["xhigh", "Extra High"],
      ["high", "High"],
    ]),
  ),
  option(
    "codex",
    "gpt-6.1-sol",
    "GPT-6.1 Sol",
    level("reasoningEffort", [
      ["high", "High"],
      ["medium", "Medium"],
      ["low", "Low"],
    ]),
  ),
  option("codex", "gpt-5.5", "GPT-5.5", null),
];

let patches: ServerSettingsPatch[] = [];
let root: Root;
let container: HTMLDivElement;

/** Holds the settings like the server does: each step in a patch replaces the stored one. */
function Screen() {
  const [value, setValue] = useState<ProjectTaskStepModels>(
    DEFAULT_SERVER_SETTINGS.taskStepModels,
  );
  return (
    <StepModelsSettings
      value={value}
      models={MODELS}
      disabled={false}
      onChange={(patch) => {
        patches.push(patch);
        setValue((current) => ({ ...current, ...patch.taskStepModels }));
      }}
    />
  );
}

const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const inSection = (section: string, label: string) =>
  container.querySelector<HTMLButtonElement>(
    `section[aria-label="${section}"] [aria-label="${label}"]`,
  );
const tap = (button: HTMLButtonElement | null) =>
  act(async () => {
    expect(button).not.toBeNull();
    button!.click();
  });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  patches = [];
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root.render(<Screen />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("StepModelsSettings (mobile)", () => {
  it("lists plan, implement and review with their default model and thinking level", () => {
    const rows = [...container.querySelectorAll('section[aria-label="단계별 모델"] button')];
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["플랜", "구현", "리뷰"]);
    expect(byLabel("플랜")!.textContent).toContain("Claude Opus 5.5 · Extra High");
    expect(byLabel("구현")!.textContent).toContain("GPT-6.1 Sol · Medium");
    expect(byLabel("구현")!.textContent).toContain("수정도 이 모델로 해요");
    expect(byLabel("리뷰")!.textContent).toContain("Claude Opus 5.5 · High");
    expect(byLabel("수정")).toBeNull();
  });

  it("changes implement's thinking level and model", async () => {
    await tap(byLabel("구현"));
    await tap(inSection("구현 생각 수준", "Low"));
    expect(patches).toEqual([
      {
        taskStepModels: {
          implement: {
            providerInstanceId: "codex",
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        },
      },
    ]);
    expect(byLabel("구현")!.textContent).toContain("GPT-6.1 Sol · Low");

    // Another model starts without the old model's thinking level.
    await tap(inSection("구현 모델", "GPT-5.5"));
    expect(patches.at(-1)).toEqual({
      taskStepModels: { implement: { providerInstanceId: "codex", model: "gpt-5.5" } },
    });
    expect(container.querySelector('section[aria-label="구현 생각 수준"]')).toBeNull();
    expect(byLabel("구현")!.textContent).toContain("GPT-5.5");
  });
});
