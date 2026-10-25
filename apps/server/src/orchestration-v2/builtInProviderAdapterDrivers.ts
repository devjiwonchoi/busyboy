import type { ProviderDriverKind } from "@t3tools/contracts";

import {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "@t3tools/provider-acp-registry/server";
import {
  ClaudeAdapterV2Driver,
  type ClaudeAdapterV2DriverEnv,
} from "./Adapters/ClaudeAdapterV2.ts";
import { CodexAdapterV2Driver, type CodexAdapterV2DriverEnv } from "./Adapters/CodexAdapterV2.ts";
import { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "@t3tools/provider-grok/server";
import type { AnyProviderAdapterDriver } from "@t3tools/provider-core/server/adapterDriver";

export type BuiltInProviderAdapterDriversV2Env =
  | AcpRegistryAdapterV2DriverEnv
  | ClaudeAdapterV2DriverEnv
  | CodexAdapterV2DriverEnv
  | GrokAdapterV2DriverEnv;

const BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2: ReadonlyArray<
  AnyProviderAdapterDriver<BuiltInProviderAdapterDriversV2Env>
> = [CodexAdapterV2Driver, ClaudeAdapterV2Driver, GrokAdapterV2Driver, AcpRegistryAdapterV2Driver];

export const BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2: ReadonlySet<ProviderDriverKind> = new Set(
  BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2.map((driver) => driver.driverKind),
);
