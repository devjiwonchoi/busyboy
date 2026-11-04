// @effect-diagnostics nodeBuiltinImport:off - Reads the desktop's computer-use events from an inherited fd.
/**
 * The server's only route to the computer-use helper: request lines go to the
 * desktop over a bootstrap fd, and the desktop answers on another. The desktop
 * supervises the helper; the server never opens its socket.
 */
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  ComputerUseError,
  DesktopComputerUseCommand,
  DesktopComputerUseEvent,
  type ComputerUseHelperStatus,
  type DesktopComputerUseCommand as DesktopComputerUseCommandType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Above the helper's 60 s maximum deadline, so the helper times out first. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;

const decodeEvent = Schema.decodeUnknownEffect(DesktopComputerUseEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopComputerUseCommand));

export interface ComputerUseNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  /** Answer only from a running helper: do not start it or extend its idle time. */
  readonly passive?: boolean;
}

export class DesktopComputerUseChannel extends Context.Service<
  DesktopComputerUseChannel,
  {
    /** False without a desktop app (headless or web mode). */
    readonly available: boolean;
    /**
     * A helper method, or `helper.status` / `helper.restart`. Interrupting the
     * request cancels it on the helper.
     */
    readonly request: (
      method: string,
      params: unknown,
      options?: RequestOptions,
    ) => Effect.Effect<unknown, ComputerUseError>;
    readonly configure: (enabled: boolean) => Effect.Effect<void>;
    readonly notifications: Stream.Stream<ComputerUseNotification>;
    readonly statusChanges: Stream.Stream<ComputerUseHelperStatus>;
    readonly status: Effect.Effect<ComputerUseHelperStatus>;
  }
>()("t3/computerUse/DesktopComputerUseChannel") {}

const desktopUnavailable = ComputerUseError.unavailable(
  "desktop_unavailable",
  "computer use needs the BusyBoy desktop app",
);
const desktopDisconnected = ComputerUseError.unavailable(
  "desktop_disconnected",
  "the BusyBoy desktop app disconnected",
);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const inputFd = config.desktopComputerUseFd;
  const controlFd = config.desktopComputerUseControlFd;

  if (inputFd === undefined || controlFd === undefined) {
    return DesktopComputerUseChannel.of({
      available: false,
      request: () => Effect.fail(desktopUnavailable),
      configure: () => Effect.void,
      notifications: Stream.empty,
      statusChanges: Stream.empty,
      status: Effect.succeed({ state: "stopped", reason: "desktop_unavailable" }),
    });
  }

  const writeLock = yield* Semaphore.make(1);
  const pending = new Map<number, Deferred.Deferred<unknown, ComputerUseError>>();
  const notifications = yield* PubSub.unbounded<ComputerUseNotification>();
  const statuses = yield* PubSub.unbounded<ComputerUseHelperStatus>();
  const latestStatus = yield* Ref.make<ComputerUseHelperStatus>({ state: "stopped" });
  let nextId = 1;
  let closed = false;

  const write = (command: DesktopComputerUseCommandType) =>
    writeLock.withPermits(1)(
      encodeCommand(command).pipe(
        Effect.flatMap((line) => writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`))),
      ),
    );

  const settle = (id: number, outcome: Effect.Effect<unknown, ComputerUseError>) => {
    const deferred = pending.get(id);
    if (!deferred) return Effect.void;
    pending.delete(id);
    return Deferred.complete(deferred, outcome).pipe(Effect.asVoid);
  };

  const disconnect = Effect.suspend(() => {
    closed = true;
    const waiting = [...pending.values()];
    pending.clear();
    const status = { state: "stopped", reason: "desktop_disconnected" } as const;
    // Status first, so a caller woken by the failure already sees it.
    return Ref.set(latestStatus, status).pipe(
      Effect.andThen(PubSub.publish(statuses, status)),
      Effect.andThen(
        Effect.forEach(waiting, (deferred) => Deferred.fail(deferred, desktopDisconnected), {
          discard: true,
        }),
      ),
    );
  });

  // A socket rather than a file read, so scope shutdown can cancel it while
  // the desktop keeps its write end open.
  const readable = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
    (stream) => Effect.sync(() => stream.destroy()),
  );
  yield* NodeStream.fromReadable<Uint8Array, Error>({
    evaluate: () => readable,
    closeOnDone: true,
    onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
    Stream.runForEach((decoded) => {
      if (Option.isNone(decoded)) return Effect.void;
      const event = decoded.value;
      switch (event.type) {
        case "response":
          return settle(
            event.id,
            event.error === undefined
              ? Effect.succeed(event.result)
              : Effect.fail(ComputerUseError.fromObject(event.error)),
          );
        case "notification":
          return PubSub.publish(notifications, { method: event.method, params: event.params });
        case "status": {
          const { type: _type, ...status } = event;
          return Ref.set(latestStatus, status).pipe(
            Effect.andThen(PubSub.publish(statuses, status)),
          );
        }
      }
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("desktop computer-use channel stopped", { cause }),
    ),
    Effect.ensuring(disconnect),
    Effect.forkScoped,
  );

  const sendCancel = (requestId: number) =>
    Effect.suspend(() => {
      const id = nextId++;
      return write({ type: "request", id, method: "cancel", params: { requestId } });
    }).pipe(Effect.ignore);

  const request = (
    method: string,
    params: unknown,
    options?: RequestOptions,
  ): Effect.Effect<unknown, ComputerUseError> =>
    Effect.suspend(() => {
      if (closed) return Effect.fail(desktopDisconnected);
      const id = nextId++;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown, ComputerUseError>();
        pending.set(id, deferred);
        yield* write({
          type: "request",
          id,
          method,
          params,
          ...(options?.passive ? { passive: true } : {}),
        }).pipe(Effect.catchCause(() => settle(id, Effect.fail(desktopDisconnected))));
        const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
        if (Option.isSome(result)) return result.value;
        pending.delete(id);
        yield* sendCancel(id);
        return yield* new ComputerUseError({
          code: "timeout",
          message: `the desktop did not answer ${method} in time`,
          details: { phase: "desktop_channel", timeoutMs },
          retryable: true,
        });
      }).pipe(
        Effect.onInterrupt(() =>
          pending.has(id)
            ? Effect.sync(() => pending.delete(id)).pipe(Effect.andThen(sendCancel(id)))
            : Effect.void,
        ),
      );
    });

  const configure = (enabled: boolean) =>
    write({ type: "configure", enabled }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("desktop computer-use configure failed", { cause }),
      ),
    );

  // The desktop starts disabled; keep it in step with the setting.
  const changes = yield* settings.subscribeChanges;
  const initial = yield* settings.getSettings.pipe(
    Effect.map((current) => current.enableAgentComputerUse),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not read the computer-use setting", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );
  let configured = initial;
  yield* configure(initial);
  yield* changes.pipe(
    Stream.runForEach((next) => {
      if (next.enableAgentComputerUse === configured) return Effect.void;
      configured = next.enableAgentComputerUse;
      return configure(configured);
    }),
    Effect.forkScoped,
  );

  return DesktopComputerUseChannel.of({
    available: true,
    request,
    configure,
    notifications: Stream.fromPubSub(notifications),
    statusChanges: Stream.fromPubSub(statuses),
    status: Ref.get(latestStatus),
  });
});

export const layer = Layer.effect(DesktopComputerUseChannel, make);
