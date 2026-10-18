import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import {
  RelayDpopAccessTokenScope,
  type RelayProtectedError as RelayProtectedErrorType,
} from "@t3tools/contracts/relay";
import { RelayProtectedError } from "@t3tools/contracts/relay";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

export interface ManagedRelayDpopProofInput {
  readonly method: HttpMethod.HttpMethod;
  readonly url: string;
  readonly accessToken?: string;
}

export class ManagedRelayDpopKeyLoadError extends Schema.TaggedError<ManagedRelayDpopKeyLoadError>()(
  "ManagedRelayDpopKeyLoadError",
  {
    keyStore: Schema.Literals(["expo-secure-store", "indexed-db"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not load relay DPoP proof key.";
  }
}

export class ManagedRelayDpopProofCreationError extends Schema.TaggedError<ManagedRelayDpopProofCreationError>()(
  "ManagedRelayDpopProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not create the relay DPoP proof for ${this.method} ${this.url}.`;
  }
}

export const ManagedRelayDpopSignerError = Schema.Union([
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopProofCreationError,
]);
export type ManagedRelayDpopSignerError = typeof ManagedRelayDpopSignerError.Type;

export const ManagedRelayRequestAction = Schema.Literals([
  "exchange relay DPoP access token",
  "list relay-managed environments",
  "list relay client devices",
  "create relay environment link challenge",
  "link relay environment",
  "unlink relay environment",
  "get relay environment status",
  "connect relay environment",
  "register relay mobile device",
  "unregister relay mobile device",
  "register relay live activity",
  "read relay agent activity snapshot",
]);
export type ManagedRelayRequestAction = typeof ManagedRelayRequestAction.Type;

export const ManagedRelayRequestActivity = Schema.Literals([
  "Relay DPoP access token exchange",
  "Relay environment listing",
  "Relay client device listing",
  "Relay environment link challenge",
  "Relay environment linking",
  "Relay environment unlinking",
  "Relay environment status request",
  "Relay environment connection",
  "Relay mobile device registration",
  "Relay mobile device unregistration",
  "Relay Live Activity registration",
  "Relay agent activity snapshot",
]);
export type ManagedRelayRequestActivity = typeof ManagedRelayRequestActivity.Type;

export class ManagedRelayRequestTimeoutError extends Schema.TaggedError<ManagedRelayRequestTimeoutError>()(
  "ManagedRelayRequestTimeoutError",
  {
    activity: ManagedRelayRequestActivity,
    timeoutMs: Schema.Number,
    traceId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `${this.activity} timed out. ${NETWORK_BLOCKING_HINT}`;
  }
}

export class ManagedRelayUrlInvalidError extends Schema.TaggedError<ManagedRelayUrlInvalidError>()(
  "ManagedRelayUrlInvalidError",
  {
    relayUrl: Schema.String,
  },
) {
  override get message(): string {
    return "Relay URL must be a secure absolute HTTPS origin.";
  }
}

export class ManagedRelayRequestFailedError extends Schema.TaggedError<ManagedRelayRequestFailedError>()(
  "ManagedRelayRequestFailedError",
  {
    action: ManagedRelayRequestAction,
    transportFailed: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
    relayError: Schema.optional(RelayProtectedError),
    status: Schema.optional(Schema.Number),
    traceId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const message = `Could not ${this.action}.`;
    return this.transportFailed ? `${message} ${NETWORK_BLOCKING_HINT}` : message;
  }
}

export class ManagedRelayAccessTokenScopesUnexpectedError extends Schema.TaggedError<ManagedRelayAccessTokenScopesUnexpectedError>()(
  "ManagedRelayAccessTokenScopesUnexpectedError",
  {
    requestedScopes: Schema.Array(RelayDpopAccessTokenScope),
    grantedScope: Schema.String,
  },
) {
  override get message(): string {
    return "Relay granted unexpected DPoP access token scopes.";
  }
}

export class ManagedRelayTokenProofCreationError extends Schema.TaggedError<ManagedRelayTokenProofCreationError>()(
  "ManagedRelayTokenProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create relay token DPoP proof.";
  }
}

export class ManagedRelayRequestProofCreationError extends Schema.TaggedError<ManagedRelayRequestProofCreationError>()(
  "ManagedRelayRequestProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create relay request DPoP proof.";
  }
}

export const ManagedRelayClientError = Schema.Union([
  ManagedRelayUrlInvalidError,
  ManagedRelayRequestFailedError,
  ManagedRelayRequestTimeoutError,
  ManagedRelayAccessTokenScopesUnexpectedError,
  ManagedRelayDpopKeyLoadError,
  ManagedRelayTokenProofCreationError,
  ManagedRelayRequestProofCreationError,
]);
export type ManagedRelayClientError = typeof ManagedRelayClientError.Type;

type RelayHttpRequestError =
  | RelayProtectedErrorType
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export class ManagedRelayDpopSigner extends Context.Service<
  ManagedRelayDpopSigner,
  {
    readonly thumbprint: Effect.Effect<string, ManagedRelayDpopKeyLoadError>;
    readonly createProof: (
      input: ManagedRelayDpopProofInput,
    ) => Effect.Effect<string, ManagedRelayDpopProofCreationError>;
  }
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayDpopSigner") {}
