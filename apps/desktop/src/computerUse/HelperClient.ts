// @effect-diagnostics nodeBuiltinImport:off - Talks to the computer-use helper over a Unix socket.
// @effect-diagnostics globalTimers:off - Bounds the connect and hello handshake.
/**
 * JSON-RPC client for the computer-use helper socket. One connection, one
 * handshake, request/response matching by id, and notifications to a listener.
 */
import * as Schema from "effect/Schema";
import * as NodeNet from "node:net";

import { encodeHelperFrame, HelperFrameDecoder } from "./HelperFraming.ts";

export const HELPER_PROTOCOL_VERSION = 1;
export const HELPER_CLIENT_NAME = "busyboy-desktop";
/** Connect plus `hello`; a helper that takes longer counts as unreachable. */
export const HELPER_HANDSHAKE_TIMEOUT_MS = 3_000;

export interface HelperErrorObject {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly details?: unknown;
  readonly retryable: boolean;
}

/** A typed error returned by the helper, or a transport failure mapped to one. */
export class HelperRequestError extends Error {
  override readonly name = "HelperRequestError";
  readonly error: HelperErrorObject;
  constructor(error: HelperErrorObject) {
    super(`${error.code}: ${error.message}`);
    this.error = error;
  }
}

const HelperErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Unknown),
  retryable: Schema.Boolean,
});

const HelperHelloSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  helperVersion: Schema.String,
  platform: Schema.String,
  capabilities: Schema.Array(Schema.String),
  /** The process serving the socket, which may not be the one BusyBoy spawned. */
  pid: Schema.optionalKey(Schema.Int),
});
export type HelperHello = typeof HelperHelloSchema.Type;

const HelperResponse = Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const HelperConnectionError = Schema.Struct({ id: Schema.Null, error: Schema.Unknown });
const HelperNotificationMessage = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

const decodeErrorObject = Schema.decodeUnknownOption(HelperErrorSchema);
const decodeHello = Schema.decodeUnknownOption(HelperHelloSchema);
const decodeResponse = Schema.decodeUnknownOption(HelperResponse);
const decodeConnectionError = Schema.decodeUnknownOption(HelperConnectionError);
const decodeNotification = Schema.decodeUnknownOption(HelperNotificationMessage);

/** A helper error with missing or mistyped fields is still an error, just not a typed one. */
const toHelperError = (raw: unknown): HelperRequestError => {
  const decoded = decodeErrorObject(raw);
  if (decoded._tag === "Some") return new HelperRequestError(decoded.value);
  return new HelperRequestError({
    code: "internal_error",
    message: "the helper sent a malformed error",
    retryable: false,
  });
};

export interface HelperNotification {
  readonly method: string;
  readonly params: unknown;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: HelperRequestError) => void;
}

const unavailable = (reason: string, message: string): HelperRequestError =>
  new HelperRequestError({
    code: "computer_use_unavailable",
    message,
    details: { reason },
    retryable: true,
  });

export class HelperClient {
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new HelperFrameDecoder();
  private nextId = 1;
  private closedError: HelperRequestError | null = null;

  private readonly socket: NodeNet.Socket;
  private readonly onNotification: (notification: HelperNotification) => void;
  private readonly onClose: (error: HelperRequestError) => void;

  private constructor(
    socket: NodeNet.Socket,
    onNotification: (notification: HelperNotification) => void,
    onClose: (error: HelperRequestError) => void,
  ) {
    this.socket = socket;
    this.onNotification = onNotification;
    this.onClose = onClose;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () =>
      this.fail(unavailable("helper_disconnected", "the helper closed the connection")),
    );
    socket.on("error", () =>
      this.fail(unavailable("helper_disconnected", "the helper connection failed")),
    );
  }

  /**
   * Connects and completes `hello` within `timeoutMs`. Rejects with
   * `version_mismatch` from the helper, `helper_disconnected` when the helper
   * closes the connection without answering, and `helper_unreachable` otherwise.
   */
  static async connect(options: {
    readonly socketPath: string;
    readonly clientVersion: string;
    readonly onNotification: (notification: HelperNotification) => void;
    readonly onClose: (error: HelperRequestError) => void;
    readonly timeoutMs?: number;
  }): Promise<{ readonly client: HelperClient; readonly hello: HelperHello }> {
    // Read from the timer and the catch, so not narrowed by the code above them.
    const held: { client: HelperClient | null; socket: NodeNet.Socket | null } = {
      client: null,
      socket: null,
    };
    const abandon = () => {
      held.socket?.destroy();
      held.client?.close();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandon();
        reject(unavailable("helper_unreachable", "the helper did not answer hello in time"));
      }, options.timeoutMs ?? HELPER_HANDSHAKE_TIMEOUT_MS);
    });
    const handshake = (async () => {
      const socket = await new Promise<NodeNet.Socket>((resolve, reject) => {
        const connection = NodeNet.createConnection(options.socketPath);
        held.socket = connection;
        connection.once("connect", () => resolve(connection));
        connection.once("error", () =>
          reject(unavailable("helper_unreachable", "could not connect to the helper socket")),
        );
      });
      const client = new HelperClient(socket, options.onNotification, options.onClose);
      held.client = client;
      const raw = await client.request("hello", {
        protocolVersion: HELPER_PROTOCOL_VERSION,
        client: HELPER_CLIENT_NAME,
        clientVersion: options.clientVersion,
      });
      const hello = decodeHello(raw);
      if (hello._tag === "None") {
        throw new HelperRequestError({
          code: "internal_error",
          message: "the helper sent a malformed hello",
          retryable: false,
        });
      }
      return { client, hello: hello.value };
    })();
    handshake.catch(() => undefined);
    timedOut.catch(() => undefined);
    try {
      return await Promise.race([handshake, timedOut]);
    } catch (error) {
      abandon();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params).response;
  }

  /** Like `request`, but also returns the JSON-RPC id, which `cancel {requestId}` names. */
  send(
    method: string,
    params: unknown,
  ): { readonly id: number; readonly response: Promise<unknown> } {
    const id = this.nextId++;
    if (this.closedError) {
      return { id, response: Promise.reject(this.closedError) };
    }
    let frame: Uint8Array;
    try {
      frame = encodeHelperFrame({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      // Nothing was sent, so nothing waits for an answer.
      return {
        id,
        response: Promise.reject(
          new HelperRequestError({
            code: "invalid_argument",
            message: `could not encode ${method}: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
          }),
        ),
      };
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.write(frame);
    return { id, response };
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  close(): void {
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    let messages: Array<unknown>;
    try {
      messages = this.decoder.push(chunk);
    } catch {
      this.fail(unavailable("invalid_frame", "the helper sent an invalid frame"));
      this.socket.destroy();
      return;
    }
    for (const message of messages) {
      this.dispatch(message);
    }
  }

  /** Validated before use; anything that is not a response, notification, or connection error is dropped. */
  private dispatch(message: unknown): void {
    const response = decodeResponse(message);
    if (response._tag === "Some") {
      const { id, error } = response.value;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error !== undefined && error !== null) pending.reject(toHelperError(error));
      else pending.resolve(response.value.result);
      return;
    }
    const rejected = decodeConnectionError(message);
    if (rejected._tag === "Some") {
      // The helper names no request when it rejects the connection itself
      // (`invalid_frame`), and closes right after.
      const error = toHelperError(rejected.value.error);
      this.fail(
        error.error.code === "version_mismatch"
          ? error
          : unavailable(error.error.code, error.error.message),
      );
      this.socket.destroy();
      return;
    }
    const notification = decodeNotification(message);
    if (notification._tag === "Some") {
      this.onNotification({
        method: notification.value.method,
        params: notification.value.params,
      });
    }
  }

  private fail(error: HelperRequestError): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
  }
}
