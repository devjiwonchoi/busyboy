import {
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
  supportsTextGeneration?: boolean;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("preserves server-provided legacy model metadata", () => {
    const baseProvider = provider({
      instanceId: "claudeAgent",
      models: ["claude-opus-4-8"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [{ ...baseProvider.models[0]!, isLegacy: true }],
      },
    ];
    const stock = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settingsWithProviderInstances(), stock)[0]?.isLegacy).toBe(
      true,
    );
  });

  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: ["claude-opus-4-8"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("claude_openrouter")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["opus"] },
        },
      },
    };
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settings, openrouter).map((option) => option.slug),
    ).toEqual(["claude-opus-4-8", "opus"]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settings,
        providers,
        "opus",
      ),
    ).toBe("opus");
  });

  it("includes Grok custom models from the selected provider instance", () => {
    const providers = [provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok" })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          config: { customModels: ["grok-test-custom-model"] },
        },
      },
    };
    const grok = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "grok",
    )!;

    expect(getAppModelOptionsForInstance(settings, grok).map((option) => option.slug)).toContain(
      "grok-test-custom-model",
    );
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("drops server-reported custom rows that are no longer in settings", () => {
    const baseProvider = provider({
      instanceId: "claude_openrouter",
      models: ["claude-sonnet-4-6"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [
          ...baseProvider.models,
          { slug: "removed/custom", name: "removed/custom", isCustom: true, capabilities: {} },
        ],
      },
    ];
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toEqual(["claude-sonnet-4-6", "openai/gpt-5.5"]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("does not add unavailable options for other providers", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: ["gpt-5.6-sol"],
      }),
    ];
    const entry = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), entry).map(
        (option) => option.slug,
      ),
    ).toEqual(["gpt-5.6-sol"]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("codex"),
        settingsWithProviderInstances(),
        providers,
        "gpt-missing",
      ),
    ).toBe("gpt-5.6-sol");
  });

  it("falls back from an explicit non-OpenCode draft with a missing model", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const providers = [provider({ provider: driver, instanceId, models: ["gpt-5.6-sol"] })];
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: instanceId,
        modelSelectionByProvider: {
          [instanceId]: createModelSelection(instanceId, "gpt-missing", [
            { id: "effort", value: "max" },
          ]),
        },
      },
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: settingsWithProviderInstances(),
    });
    const dispatch = getComposerProviderState({
      provider: driver,
      model: state.selectedModel,
      models: providers[0]!.models,
      modelOptions: state.modelOptions?.[instanceId],
      planModeEnabled: false,
    });

    expect(state.selectedModel).toBe("gpt-5.6-sol");
    expect(dispatch.modelOptionsForDispatch).toBeUndefined();
  });

  it("keeps a custom-instance draft model while dropping unsupported options", () => {
    const instanceId = ProviderInstanceId.make("claude_openrouter");
    const driver = ProviderDriverKind.make("claudeAgent");
    const providers = [
      provider({ provider: driver, instanceId: "claudeAgent", models: ["claude-opus-5"] }),
      provider({ provider: driver, instanceId, models: ["claude-opus-5"] }),
    ];
    const threadSelection = createModelSelection(instanceId, "claude-opus-5", [
      { id: "effort", value: "high" },
    ]);
    const draftSelection = createModelSelection(instanceId, "openai/gpt-5.5", [
      { id: "effort", value: "max" },
    ]);
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: instanceId,
        modelSelectionByProvider: { [instanceId]: draftSelection },
      },
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: threadSelection,
      projectModelSelection: null,
      settings: settingsWithProviderInstances(),
    });
    const dispatch = getComposerProviderState({
      provider: driver,
      model: state.selectedModel,
      models: providers[1]!.models,
      modelOptions: state.modelOptions?.[instanceId],
      planModeEnabled: false,
    });

    expect(
      createModelSelection(instanceId, state.selectedModel, dispatch.modelOptionsForDispatch),
    ).toEqual(createModelSelection(instanceId, "openai/gpt-5.5"));
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });

  it("self-heals a persisted selection pointing at a text-generation-incapable instance", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("acpRegistry"),
        instanceId: "acp_gemini",
        models: ["default"],
        supportsTextGeneration: false,
      }),
      provider({
        instanceId: "codex",
        models: ["gpt-5.6-luna"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("acp_gemini"),
        model: "default",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers).instanceId).toBe(
      ProviderInstanceId.make("codex"),
    );
  });
  it("falls back to the text generation default, not the chat default, for a removed model", () => {
    const codex = provider({ instanceId: "codex", models: ["gpt-6-astra", "gpt-6-luna"] });
    const providers = [
      { ...codex, models: codex.models.map((m, i) => (i === 0 ? { ...m, isDefault: true } : m)) },
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.6-luna",
      ),
    };

    expect(resolveAppModelSelectionState(settings, providers).model).toBe(
      DEFAULT_TEXT_GENERATION_MODEL,
    );
  });

  it("does not select a provider that cannot generate system text", () => {
    const instanceId = ProviderInstanceId.make("grok");
    const unsupported = {
      ...provider({
        provider: ProviderDriverKind.make("grok"),
        instanceId,
        models: ["gemini-3.1-pro"],
      }),
      supportsTextGeneration: false,
    };
    const supported = provider({ instanceId: "codex", models: ["gpt-5.6-sol"] });
    const settings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: createModelSelection(instanceId, "gemini-3.1-pro"),
    };

    expect(resolveAppModelSelectionState(settings, [unsupported, supported])).toEqual(
      createModelSelection(supported.instanceId, "gpt-5.6-sol"),
    );
    expect(resolveAppModelSelectionState(settings, [unsupported])).toEqual(
      NO_PROVIDER_MODEL_SELECTION,
    );
  });
});

describe("resolveAppModelSelectionState with the opencode plan agent", () => {
  const instanceId = ProviderInstanceId.make("opencode");
  const model = "opencode/gpt-5.4";
  const opencode: ServerProvider = {
    ...provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "agent",
              label: "Agent",
              type: "select",
              options: [
                { id: "build", label: "Build", isDefault: true },
                { id: "plan", label: "Plan" },
              ],
              currentValue: "build",
            },
          ],
        },
      },
    ],
  };
  const settings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    planModeEnabled: false,
    textGenerationModelSelection: createModelSelection(instanceId, model, [
      { id: "agent", value: "plan" },
    ]),
  };

  it("keeps a stored plan agent this device did not pick", () => {
    expect(resolveAppModelSelectionState(settings, [opencode])).toEqual(
      createModelSelection(instanceId, model, [{ id: "agent", value: "plan" }]),
    );
  });
});
