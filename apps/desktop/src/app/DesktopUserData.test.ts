import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("keeps BusyBoy's Electron profile apart from T3 Code's t3code-v2 / t3code-dev", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: "/profiles", isDevelopment: false }),
      "/profiles/busyboy-userdata",
    );
    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: "/profiles", isDevelopment: true }),
      "/profiles/busyboy-userdata-dev",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
