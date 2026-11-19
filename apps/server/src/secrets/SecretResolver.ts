import type { ServerSettings } from "@t3tools/contracts";
import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    return SecretResolverCore.layer({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
    });
  }),
);
