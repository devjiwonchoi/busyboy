import { isProviderDriverKind } from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { grokClient } from "@t3tools/provider-grok/client";

const providerClients = makeProviderClientRegistry([grokClient, acpRegistryClient]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
