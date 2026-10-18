import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionAttemptError } from "../connection/model.ts";

export type RelayEnvironmentAvailability = "checking" | "online" | "offline" | "error";

export interface RelayDiscoveredEnvironment {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: RelayEnvironmentAvailability;
  readonly status: Option.Option<RelayEnvironmentStatusResponse>;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export interface RelayEnvironmentDiscoveryState {
  readonly environments: ReadonlyMap<string, RelayDiscoveredEnvironment>;
  readonly refreshing: boolean;
  readonly offline: boolean;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export class RelayEnvironmentDiscovery extends Context.Service<
  RelayEnvironmentDiscovery,
  {
    readonly state: SubscriptionRef.SubscriptionRef<RelayEnvironmentDiscoveryState>;
    readonly refresh: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/discovery/RelayEnvironmentDiscovery") {}

export const EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE: RelayEnvironmentDiscoveryState = {
  environments: new Map(),
  refreshing: false,
  offline: false,
  error: Option.none(),
};

/** Empty compatibility state for previously saved hosted connections. No account discovery runs. */
export const make = Effect.fn("RelayEnvironmentDiscovery.make")(function* () {
  const state = yield* SubscriptionRef.make(EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE);
  return RelayEnvironmentDiscovery.of({ state, refresh: Effect.void });
});
export const layer = Layer.effect(RelayEnvironmentDiscovery, make());
