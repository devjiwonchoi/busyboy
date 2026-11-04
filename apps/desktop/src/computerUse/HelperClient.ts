// @effect-diagnostics nodeBuiltinImport:off - Talks to the computer-use helper over a Unix socket.
/**
 * JSON-RPC client for the computer-use helper socket. One connection, one
 * handshake, request/response matching by id, and notifications to a listener.
 */
import * as NodeNet from "node:net";

import { encodeHelperFrame, HelperFrameDecoder } from "./HelperFraming.ts";

export const HELPER_PROTOCOL_VERSION = 1;
export const HELPER_CLIENT_NAME = "busyboy-desktop";

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

export interface HelperHello {
  readonly protocolVersion: number;
  readonly helperVersion: string;
  readonly platform: string;
  readonly capabilities: ReadonlyArray<string>;
}

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

  /** Connects and completes `hello`. Rejects with `version_mismatch` from the helper. */
  static async connect(options: {
    readonly socketPath: string;
    readonly clientVersion: string;
    readonly onNotification: (notification: HelperNotification) => void;
    readonly onClose: (error: HelperRequestError) => void;
  }): Promise<{ readonly client: HelperClient; readonly hello: HelperHello }> {
    const socket = await new Promise<NodeNet.Socket>((resolve, reject) => {
      const connection = NodeNet.createConnection(options.socketPath);
      connection.once("connect", () => resolve(connection));
      connection.once("error", () =>
        reject(unavailable("helper_unreachable", "could not connect to the helper socket")),
      );
    });
    const client = new HelperClient(socket, options.onNotification, options.onClose);
    try {
      const hello = (await client.request("hello", {
        protocolVersion: HELPER_PROTOCOL_VERSION,
        client: HELPER_CLIENT_NAME,
        clientVersion: options.clientVersion,
      })) as HelperHello;
      return { client, hello };
    } catch (error) {
      client.close();
      throw error;
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
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeHelperFrame({ jsonrpc: "2.0", id, method, params }));
    });
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
      this.dispatch(message as Record<string, unknown>);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new HelperRequestError(message.error as HelperErrorObject));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (id === null && message.error) {
      // The helper names no request when it rejects the connection itself
      // (`invalid_frame`), and closes right after.
      const error = message.error as HelperErrorObject;
      this.fail(
        error.code === "version_mismatch"
          ? new HelperRequestError(error)
          : unavailable(error.code, error.message),
      );
      this.socket.destroy();
      return;
    }
    if (typeof message.method === "string") {
      this.onNotification({ method: message.method, params: message.params });
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
