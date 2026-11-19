import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderDriverCreateInput } from "./driver.ts";
export type { ProviderDriverCreateInput as ProviderAdapterDriverCreateInput } from "./driver.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class ProviderAdapterDriverCreateError extends Schema.TaggedError<ProviderAdapterDriverCreateError>()(
  "ProviderAdapterDriverCreateError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create orchestration-v2 provider adapter ${this.instanceId} (${this.driver}): ${this.detail}`;
  }
}

export interface ProviderAdapterDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2["Service"],
    ProviderAdapterDriverCreateError,
    R | Scope.Scope
  >;
}

// oxlint-disable-next-line typescript/no-explicit-any -- Config appears in both input and output positions, so only any accepts every driver
export type AnyProviderAdapterDriver<R = never> = ProviderAdapterDriver<any, R>;
