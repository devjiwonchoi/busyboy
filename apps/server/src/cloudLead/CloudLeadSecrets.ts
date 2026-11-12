/**
 * Long-lived secrets for cloud task leads (Vercel Sandbox): Vercel token and
 * ids, the Claude setup-token, a GitHub token, and MCP auth values. Each is
 * kept in the server secret store under a fixed name, so the code that starts
 * a cloud lead can read it back. Values never leave this module except as
 * Redacted, and errors carry only the kind.
 */
import type { CloudLeadSecretKind } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no sync sha256.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const MAX_NAME_LENGTH = 256;

export class CloudLeadSecretsError extends Schema.TaggedError<CloudLeadSecretsError>()(
  "CloudLeadSecretsError",
  {
    reason: Schema.Literals(["name_required", "name_not_allowed", "name_invalid", "store_failed"]),
    kind: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "name_required":
        return "A name is required for kind mcp, as '<server>:<KEY>'.";
      case "name_not_allowed":
        return `Kind ${this.kind} does not take a name.`;
      case "name_invalid":
        return `The name must be 1-${MAX_NAME_LENGTH} characters without surrounding whitespace.`;
      case "store_failed":
        return `Could not access the stored ${this.kind} secret.`;
    }
  }
}

export interface CloudLeadSecretKey {
  readonly kind: CloudLeadSecretKind;
  readonly name?: string | undefined;
}

/** The secret store name for a kind (and name, for mcp). */
export const storeName = (
  key: CloudLeadSecretKey,
): Effect.Effect<string, CloudLeadSecretsError> => {
  if (key.kind !== "mcp") {
    return key.name === undefined
      ? Effect.succeed(`cloud-lead-${key.kind}`)
      : Effect.fail(new CloudLeadSecretsError({ reason: "name_not_allowed", kind: key.kind }));
  }
  if (key.name === undefined) {
    return Effect.fail(new CloudLeadSecretsError({ reason: "name_required", kind: key.kind }));
  }
  if (key.name.length === 0 || key.name.length > MAX_NAME_LENGTH || key.name.trim() !== key.name) {
    return Effect.fail(new CloudLeadSecretsError({ reason: "name_invalid", kind: key.kind }));
  }
  const digest = NodeCrypto.createHash("sha256").update(key.name).digest("hex").slice(0, 32);
  return Effect.succeed(`cloud-lead-mcp-${digest}`);
};

export class CloudLeadSecrets extends Context.Service<
  CloudLeadSecrets,
  {
    readonly save: (
      input: CloudLeadSecretKey & { readonly value: string },
    ) => Effect.Effect<void, CloudLeadSecretsError>;
    readonly read: (
      input: CloudLeadSecretKey,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, CloudLeadSecretsError>;
  }
>()("t3/cloudLead/CloudLeadSecrets") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;

  const storeFailed = (kind: CloudLeadSecretKind) => (cause: ServerSecretStore.SecretStoreError) =>
    new CloudLeadSecretsError({ reason: "store_failed", kind, cause });

  const save: CloudLeadSecrets["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "cloud_lead_secret.kind": input.kind });
      const name = yield* storeName(input);
      yield* store
        .set(name, new TextEncoder().encode(input.value))
        .pipe(Effect.mapError(storeFailed(input.kind)));
    }).pipe(Effect.withSpan("CloudLeadSecrets.save"));

  const read: CloudLeadSecrets["Service"]["read"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "cloud_lead_secret.kind": input.kind });
      const name = yield* storeName(input);
      const stored = yield* store.get(name).pipe(Effect.mapError(storeFailed(input.kind)));
      return Option.map(stored, (bytes) => Redacted.make(new TextDecoder().decode(bytes)));
    }).pipe(Effect.withSpan("CloudLeadSecrets.read"));

  return CloudLeadSecrets.of({ save, read });
});

export const layer = Layer.effect(CloudLeadSecrets, make);
