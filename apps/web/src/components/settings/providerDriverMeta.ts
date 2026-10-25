import { ClaudeSettings, CodexSettings, ProviderDriverKind } from "@busyboy/contracts";
import { acpRegistryClient } from "@busyboy/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@busyboy/provider-core/client";
import { grokClient } from "@busyboy/provider-grok/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  grokClient,
  acpRegistryClient,
]);
