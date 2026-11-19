import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type * as Stream from "effect/Stream";

export type ProviderSnapshotSource = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
