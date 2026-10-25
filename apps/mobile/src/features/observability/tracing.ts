import Constants from "expo-constants";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { resolveTracingPublicConfig } from "./publicConfig";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

export function resolveTracingConfig(): TracingConfig | null {
  return resolveTracingPublicConfig();
}

export function layerFromConfig(config: TracingConfig | null, resource: TracingResource) {
  return RelayTracing.layer(config, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
  });
}

export const layer = layerFromConfig(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
