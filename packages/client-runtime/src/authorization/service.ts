import {
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import {
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import {
  environmentMismatchError,
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";

import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export interface AuthorizedRemoteHttpEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }>;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      /**
       * The access token is not bound to an origin, and each proof is minted
       * for the URL it signs, so a token from the relay also works on the
       * environment's LAN or tailnet address.
       */
      readonly directEndpoint?: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const BEARER_DESCRIPTOR_CACHE_TTL_MS = 10_000;
const DPOP_AUTHORIZATION_TIMEOUT_MS = 30_000;

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
  connectionMethod: ClientConnectionMethod,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError((error) => mapRemoteEnvironmentError(error, connectionMethod)),
  );
});

export const make = Effect.gen(function* () {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const bearerDescriptors = yield* Ref.make<
    ReadonlyMap<
      EnvironmentId,
      {
        readonly httpBaseUrl: string;
        readonly descriptor: ExecutionEnvironmentDescriptor;
        readonly validatedAtEpochMs: number;
      }
    >
  >(new Map());

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const now = yield* Clock.currentTimeMillis;
      const cachedDescriptor = (yield* Ref.get(bearerDescriptors)).get(input.expectedEnvironmentId);
      const canReuseDescriptor =
        cachedDescriptor?.httpBaseUrl === input.httpBaseUrl &&
        cachedDescriptor.validatedAtEpochMs + BEARER_DESCRIPTOR_CACHE_TTL_MS > now;
      const descriptor = canReuseDescriptor
        ? cachedDescriptor.descriptor
        : yield* fetchDescriptor(input.httpBaseUrl, input.connectionMethod).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      if (!canReuseDescriptor) {
        yield* Ref.update(bearerDescriptors, (current) => {
          const next = new Map(current);
          next.set(input.expectedEnvironmentId, {
            httpBaseUrl: input.httpBaseUrl,
            descriptor,
            validatedAtEpochMs: now,
          });
          return next;
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "configuration",
          detail:
            "This connection uses a removed hosted-account integration. Pair it directly instead.",
        }),
      ),
    authorizeDpopHttp: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "configuration",
          detail:
            "This connection uses a removed hosted-account integration. Pair it directly instead.",
        }),
      ),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
