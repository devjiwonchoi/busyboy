// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * The Mac end of a cloud lead's relay. It keeps one WebSocket to the sandbox
 * relay open, reconnecting after drops, and carries:
 * - remote claude processes (spawnRemote), and
 * - the sandbox's MCP requests, answered by fetching the Mac's own endpoint.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { RelaySession, type RelayLink, type RelayMessage } from "./relay/session.ts";

/** What a WebSocket gives the client; tests pass an in-memory pair. */
export interface RelaySocket {
  readonly send: (line: string) => void;
  readonly close: () => void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

export const globalWebSocketFactory: RelaySocketFactory = (url) =>
  new WebSocket(url) as unknown as RelaySocket;

export interface RelayClientOptions {
  readonly url: string;
  readonly token: string;
  /**
   * The Mac's t3-code MCP endpoint, e.g. http://127.0.0.1:3773/mcp. Sandbox
   * requests are forwarded only to this path, never to other server routes.
   */
  readonly mcpEndpoint: string;
  readonly socketFactory?: RelaySocketFactory;
  readonly fetch?: typeof globalThis.fetch;
  readonly reconnectDelayMs?: (attempt: number) => number;
  /**
   * How long the relay may stay unreachable before the client gives up: its
   * remote processes then exit, so a dead sandbox fails the turn instead of
   * hanging it.
   */
  readonly giveUpAfterMs?: number;
  /** Called once when the client gives up on an unreachable relay. */
  readonly onGiveUp?: () => void;
}

const DEFAULT_GIVE_UP_AFTER_MS = 2 * 60 * 1000;

export interface RemoteSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Matches the SDK's SpawnedProcess, so it drops into spawnClaudeCodeProcess. */
export class RemoteProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  private readonly sendToRelay: (message: Omit<RelayMessage, "ch">) => void;

  constructor(sendToRelay: (message: Omit<RelayMessage, "ch">) => void) {
    super();
    this.sendToRelay = sendToRelay;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.sendToRelay({ op: "stdin", data: Buffer.from(chunk).toString("base64") });
        callback();
      },
      final: (callback) => {
        this.sendToRelay({ op: "end" });
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.sendToRelay({ op: "kill", signal });
    return true;
  }

  /** @internal */
  handle(message: RelayMessage): void {
    if (this.exitCode !== null) return;
    if (message.op === "stdout") this.stdout.write(Buffer.from(String(message.data), "base64"));
    else if (message.op === "stderr") {
      this.stderr.write(Buffer.from(String(message.data), "base64"));
    } else if (message.op === "error") {
      // The SDK listens for "error"; without a listener it would throw.
      if (this.listenerCount("error") > 0) this.emit("error", new Error(String(message.message)));
    } else if (message.op === "exit") {
      this.exitCode = typeof message.code === "number" ? message.code : 1;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", message.code ?? null, message.signal ?? null);
    }
  }
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  // fetch already decoded the body.
  "content-encoding",
  "upgrade",
]);

export class RelayClient {
  private readonly options: RelayClientOptions;
  private readonly session: RelaySession;
  private readonly processes = new Map<string, RemoteProcess>();
  private readonly httpAborts = new Map<string, AbortController>();
  private socket: RelaySocket | null = null;
  private link: RelayLink | null = null;
  private closed = false;
  private attempt = 0;
  private nextProcess = 0;
  /** When the relay last stopped being reachable; null while connected. */
  private unreachableSince: number | null = Date.now();
  private readonly ackTimer: ReturnType<typeof setInterval>;
  private readonly connectionWaiters: Array<() => void> = [];
  /** How many times a connection was established, for tests and logs. */
  connections = 0;

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.session = new RelaySession({ onMessage: (message) => this.handle(message) });
    this.ackTimer = setInterval(() => this.session.ack(), 1_000);
    this.ackTimer.unref?.();
    this.connect();
  }

  get connected(): boolean {
    return this.session.connected;
  }

  /** Resolves once the relay answered the hello on some connection. */
  waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The cloud relay did not answer within ${timeoutMs} ms.`)),
        timeoutMs,
      );
      this.connectionWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  spawnRemote(input: RemoteSpawnInput): RemoteProcess {
    const id = `p${++this.nextProcess}`;
    const child = new RemoteProcess((message) => this.session.send({ ch: "proc", id, ...message }));
    this.processes.set(id, child);
    child.once("exit", () => this.processes.delete(id));
    this.session.send({
      ch: "proc",
      op: "spawn",
      id,
      cmd: input.command,
      args: [...input.args],
      cwd: input.cwd,
      env: { ...input.env },
    });
    return child;
  }

  /** Simulates a network drop; the client reconnects on its own. For tests. */
  dropConnection(): void {
    this.socket?.close();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.ackTimer);
    this.socket?.close();
    for (const child of this.processes.values()) {
      if (child.exitCode === null) child.handle({ ch: "proc", op: "exit", code: 1, signal: null });
    }
    for (const controller of this.httpAborts.values()) controller.abort();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = (this.options.socketFactory ?? globalWebSocketFactory)(this.options.url);
    this.socket = socket;
    const link: RelayLink = {
      send: (line) => socket.send(line),
      close: () => socket.close(),
    };
    let lost = false;
    const onLost = () => {
      if (lost) return;
      lost = true;
      this.session.detach(link);
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      this.unreachableSince ??= Date.now();
      if (Date.now() - this.unreachableSince > (this.options.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS)) {
        this.close();
        this.options.onGiveUp?.();
        return;
      }
      const delay =
        this.options.reconnectDelayMs?.(this.attempt) ?? Math.min(250 * 2 ** this.attempt, 5_000);
      this.attempt += 1;
      setTimeout(() => this.connect(), delay);
    };
    socket.onopen = () => {
      this.link = link;
      this.session.attach(link, this.options.token);
    };
    socket.onmessage = (event) => {
      const line = typeof event.data === "string" ? event.data : String(event.data);
      const wasConnected = this.session.connected;
      try {
        this.session.receive(link, line);
      } catch {
        socket.close();
        return;
      }
      if (!wasConnected && this.session.connected) {
        this.attempt = 0;
        this.unreachableSince = null;
        this.connections += 1;
        for (const waiter of this.connectionWaiters.splice(0)) waiter();
      }
    };
    socket.onclose = onLost;
    socket.onerror = () => {
      try {
        socket.close();
      } catch {}
      onLost();
    };
  }

  private handle(message: RelayMessage): void {
    if (message.ch === "proc") {
      this.processes.get(String(message.id))?.handle(message);
      return;
    }
    if (message.ch !== "http") return;
    const id = String(message.id);
    if (message.op === "abort") {
      this.httpAborts.get(id)?.abort();
      this.httpAborts.delete(id);
      return;
    }
    if (message.op === "request") void this.forward(id, message);
  }

  private async forward(id: string, message: RelayMessage): Promise<void> {
    const controller = new AbortController();
    this.httpAborts.set(id, controller);
    const headers = new Headers();
    for (const [key, value] of Object.entries(
      (message.headers ?? {}) as Record<string, string | string[] | undefined>,
    )) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = String(message.method);
    const body = Buffer.from(String(message.body ?? ""), "base64");
    const endpoint = new URL(this.options.mcpEndpoint);
    const target = new URL(String(message.path), endpoint.origin);
    if (
      target.origin !== endpoint.origin ||
      (target.pathname !== endpoint.pathname && !target.pathname.startsWith(`${endpoint.pathname}/`))
    ) {
      this.httpAborts.delete(id);
      this.session.send({ ch: "http", op: "head", id, status: 403, headers: {} });
      this.session.send({ ch: "http", op: "end", id });
      return;
    }
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(
        target.toString(),
        {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" || body.length === 0 ? {} : { body }),
          signal: controller.signal,
        },
      );
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key)) responseHeaders[key] = value;
      });
      this.session.send({
        ch: "http",
        op: "head",
        id,
        status: response.status,
        headers: responseHeaders,
      });
      if (response.body !== null) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          this.session.send({
            ch: "http",
            op: "chunk",
            id,
            data: Buffer.from(chunk).toString("base64"),
          });
        }
      }
      this.session.send({ ch: "http", op: "end", id });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.session.send({
          ch: "http",
          op: "error",
          id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.httpAborts.delete(id);
    }
  }
}
