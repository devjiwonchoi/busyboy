import "~/index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ProjectTaskStepModels,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const AT = "2026-11-11T03:00:00.000Z";

/** The server's step models and the patches the settings screen sent. */
const server = vi.hoisted(() => ({
  stepModels: null as unknown as ProjectTaskStepModels,
  patches: [] as unknown[],
  listeners: new Set<() => void>(),
  providers: [] as ServerProvider[],
}));

function useServer<T>(read: () => T): T {
  return useSyncExternalStore((listener) => {
    server.listeners.add(listener);
    return () => server.listeners.delete(listener);
  }, read);
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = {
    scope: { kind: "environment" },
    target: { environmentId: "env-1" },
    environment: { environmentId: "env-1" },
    environments: [],
    targets: [],
  };
  return {
    ...(await original()),
    useSettingsScope: (() => scope) as never,
    useOptionalSettingsScope: (() => scope) as never,
  };
});

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector?: (settings: unknown) => unknown) => {
    const stepModels = useServer(() => server.stepModels);
    const settings = { ...DEFAULT_SERVER_SETTINGS, taskStepModels: stepModels };
    return selector ? selector(settings) : settings;
  }) as never,
  // Mirrors the server: each step in the patch replaces the stored one.
  useUpdateScopedSettings: (() => (patch: { taskStepModels?: Partial<ProjectTaskStepModels> }) => {
    server.patches.push(patch);
    server.stepModels = { ...server.stepModels, ...patch.taskStepModels };
    for (const listener of server.listeners) listener();
  }) as never,
}));

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    control,
    resetAction,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    resetAction?: ReactNode;
  }) => (
    <div data-settings-row="" className="flex items-center justify-between gap-3 py-2">
      <div>
        <div className="text-sm">{title}</div>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="flex items-center gap-1">
        {resetAction}
        {control}
      </div>
    </div>
  )) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => [ENVIRONMENT_ID]) as never,
  useEnvironmentProviders: (() => new Map([[ENVIRONMENT_ID, server.providers]])) as never,
}));

import { StepModelsSettingsSection } from "./StepModelsSettings";

const effort = (id: string, levels: ReadonlyArray<[string, string]>) => ({
  optionDescriptors: [
    {
      id,
      label: "Reasoning",
      type: "select" as const,
      options: levels.map(([value, label]) => ({ id: value, label })),
    },
  ],
});

const provider = (
  instanceId: string,
  driver: string,
  models: ServerProvider["models"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: AT,
  models,
  slashCommands: [],
  skills: [],
});

const PROVIDERS = [
  provider("claudeAgent", "claudeAgent", [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: effort("effort", [
        ["xhigh", "Extra High"],
        ["high", "High"],
        ["medium", "Medium"],
      ]),
    },
  ]),
  provider("codex", "codex", [
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      isCustom: false,
      capabilities: effort("reasoningEffort", [
        ["high", "High"],
        ["medium", "Medium"],
        ["low", "Low"],
      ]),
    },
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
  ]),
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.stepModels = DEFAULT_SERVER_SETTINGS.taskStepModels;
  server.patches = [];
  server.providers = PROVIDERS;
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "width: 100%; padding: 12px; box-sizing: border-box;";
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

async function choose(trigger: HTMLElement, name: string) {
  await userEvent.click(trigger);
  const option = await vi.waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) => element.textContent?.trim().startsWith(name),
    );
    expect(match, `option ${name}`).toBeDefined();
    return match!;
  });
  await userEvent.click(option);
}

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  describe(`models per step (${viewport.name})`, () => {
    beforeEach(async () => {
      await page.viewport(viewport.width, viewport.height);
    });

    it("shows plan, implement and review with their thinking levels and saves a change", async () => {
      await act(async () => root.render(<StepModelsSettingsSection />));
      expect(container.textContent).toContain("단계별 모델");
      // Only the three steps; fix follows implement.
      expect(container.textContent).toContain("수정도 이 모델로 해요");
      expect(byLabel("수정 모델")).toBeNull();
      expect(byLabel("플랜 모델")!.textContent).toContain("Claude Opus 5.5");
      expect(byLabel("플랜 생각 수준")!.textContent).toContain("Extra High");
      expect(byLabel("구현 모델")!.textContent).toContain("GPT-6.1 Sol");
      expect(byLabel("구현 생각 수준")!.textContent).toContain("Medium");
      expect(byLabel("리뷰 생각 수준")!.textContent).toContain("High");

      await choose(byLabel("구현 생각 수준")!, "Low");
      expect(server.patches).toEqual([
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
      await vi.waitFor(() => expect(byLabel("구현 생각 수준")!.textContent).toContain("Low"));

      // A model without a thinking level drops the old one and hides the level picker.
      await userEvent.click(byLabel("구현 모델")!);
      const option = await vi.waitFor(() => {
        const match = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (element) => element.textContent?.includes("GPT-5.5"),
        );
        expect(match).toBeDefined();
        return match!;
      });
      await userEvent.click(option);
      expect(server.patches.at(-1)).toEqual({
        taskStepModels: { implement: { providerInstanceId: "codex", model: "gpt-5.5" } },
      });
      await vi.waitFor(() => expect(byLabel("구현 생각 수준")).toBeNull());

      // Back to the default in one click.
      await userEvent.click(byLabel("Reset 구현 모델 to default")!);
      expect(server.patches.at(-1)).toEqual({
        taskStepModels: { implement: DEFAULT_SERVER_SETTINGS.taskStepModels.implement },
      });
      await page.screenshot({ path: `__screenshots__/step-models-${viewport.name}.png` });
    });
  });
}
