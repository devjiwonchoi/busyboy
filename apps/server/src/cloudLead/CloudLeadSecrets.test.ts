import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudLeadSecrets from "./CloudLeadSecrets.ts";

const withService = <A, E>(
  body: (input: {
    readonly service: CloudLeadSecrets.CloudLeadSecrets["Service"];
    readonly stored: Map<string, Uint8Array>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const service = yield* CloudLeadSecrets.CloudLeadSecrets.pipe(
      Effect.provide(
        CloudLeadSecrets.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ServerSecretStore.ServerSecretStore,
              ServerSecretStore.ServerSecretStore.of({
                get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
                set: (name, value) => Effect.sync(() => void stored.set(name, value)),
                create: (name, value) => Effect.sync(() => void stored.set(name, value)),
                getOrCreateRandom: () => Effect.die("unused"),
                remove: (name) => Effect.sync(() => void stored.delete(name)),
              }),
            ),
          ),
        ),
      ),
    );
    return yield* body({ service, stored });
  });

it.effect("saves a secret and reads it back redacted", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* service.read({ kind: "vercel_token" })));
      yield* service.save({ kind: "vercel_token", value: "token-1" });
      yield* service.save({ kind: "vercel_token", value: "token-2" });
      const read = yield* service.read({ kind: "vercel_token" });
      assert.isTrue(Option.isSome(read) && Redacted.isRedacted(read.value));
      assert.strictEqual(Redacted.value(Option.getOrThrow(read)), "token-2");
      assert.deepStrictEqual([...stored.keys()], ["cloud-lead-vercel_token"]);
      assert.notInclude(String(Option.getOrThrow(read)), "token-2");
    }),
  ),
);

it.effect("requires a name for mcp and refuses one for other kinds", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      const missing = yield* service.save({ kind: "mcp", value: "v" }).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "name_required");
      const extra = yield* service
        .save({ kind: "github_token", name: "x", value: "v" })
        .pipe(Effect.flip);
      assert.strictEqual(extra.reason, "name_not_allowed");
      const blank = yield* service.read({ kind: "mcp", name: " linear:KEY" }).pipe(Effect.flip);
      assert.strictEqual(blank.reason, "name_invalid");
      const tooLong = yield* service
        .save({ kind: "mcp", name: "a".repeat(257), value: "v" })
        .pipe(Effect.flip);
      assert.strictEqual(tooLong.reason, "name_invalid");
      assert.strictEqual(stored.size, 0);
    }),
  ),
);

it.effect("keeps each kind and mcp name under its own safe store name", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.save({ kind: "mcp", name: "linear:API_KEY", value: "linear" });
      yield* service.save({ kind: "mcp", name: "../github:TOKEN", value: "github" });
      yield* service.save({ kind: "claude_oauth_token", value: "claude" });
      const names = [...stored.keys()];
      assert.strictEqual(new Set(names).size, 3);
      for (const name of names) assert.match(name, /^cloud-lead-[a-z_]+(-[0-9a-f]{32})?$/);
      assert.isTrue(names.some((name) => /^cloud-lead-mcp-[0-9a-f]{32}$/.test(name)));
      const linear = yield* service.read({ kind: "mcp", name: "linear:API_KEY" });
      assert.strictEqual(Redacted.value(Option.getOrThrow(linear)), "linear");
      const github = yield* service.read({ kind: "mcp", name: "../github:TOKEN" });
      assert.strictEqual(Redacted.value(Option.getOrThrow(github)), "github");
    }),
  ),
);
