import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

// Returns the trigger's visible text, which is what the user reads before opening the picker.
async function triggerText(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  const text = container.querySelector("button")?.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  triggerLabel?: string;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver);
  return triggerText(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      onInstanceModelChange={() => {}}
      {...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {})}
    />,
  );
}

describe("ProviderModelPicker", () => {
  it("shows a neutral aggregate value without a representative model or availability badge", async () => {
    const label = await renderPicker({
      instanceId: "codex_personal",
      driver: "codex",
      model: "gpt-5",
      options: [{ slug: "gpt-5", name: "GPT 5", isUnavailable: true }],
      triggerLabel: "Mixed values",
    });
    expect(label).toContain("Mixed values");
    expect(label).not.toContain("GPT 5");
    expect(label).not.toContain("Unavailable");
  });

  it.each(["codex", "claudeAgent", "grok"])(
    "uses the first option label for a missing %s model",
    async (driver) => {
      const label = await renderPicker({
        instanceId: `${driver}_work`,
        driver,
        model: "missing-model",
        options: [{ slug: "fallback-model", name: "Fallback model" }],
      });

      expect(label).toContain("Fallback model");
      expect(label).not.toContain("missing-model");
    },
  );

  it("prefers a matching model", async () => {
    const label = await renderPicker({
      instanceId: "custom_runtime",
      driver: "grok",
      model: "openrouter/selected",
      options: [
        { slug: "openrouter/fallback", name: "Fallback model" },
        { slug: "openrouter/selected", name: "Selected model" },
      ],
    });

    expect(label).toContain("Selected model");
    expect(label).not.toContain("Fallback model");
  });

  it("uses the first option when the active instance entry is missing", async () => {
    const label = await renderPicker({
      instanceId: "missing_instance",
      driver: "grok",
      model: "missing-model",
      options: [{ slug: "fallback-model", name: "Fallback model" }],
      includeEntry: false,
    });

    expect(label).toContain("Fallback model");
    expect(label).not.toContain("missing-model");
  });

  it("keeps instance initials visible in the resting trigger", async () => {
    const activeEntry = providerEntry("codex_personal", "codex");
    const label = await triggerText(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={activeEntry.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={[providerEntry("codex", "codex"), activeEntry]}
        modelOptionsByInstance={new Map()}
        size="xs"
        onInstanceModelChange={() => {}}
      />,
    );

    expect(label).toContain("CP");
  });
});
