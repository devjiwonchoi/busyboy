// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * A message session that survives reconnects.
 *
 * Both ends number every message they send and keep it until the other end
 * acknowledges it. When a connection drops and a new one opens, each end says
 * the last number it received and the other end sends again everything after
 * it, in order. Messages seen before are dropped, so the stream on each side is
 * exactly once and in order across any number of reconnects.
 *
 * This file runs on the Mac and, unchanged, inside the sandbox relay
 * (`node relay/server.ts`), so it imports nothing.
 */

export type RelayMessage = { readonly ch: string; readonly [key: string]: unknown };

/** One wire line. `s` is set on data frames; `a` is the sender's last received seq. */
interface Frame {
  readonly t: "data" | "ack" | "hello";
  readonly s?: number;
  readonly a: number;
  readonly m?: RelayMessage;
  readonly token?: string;
}

/** A connection: a socket that may close at any time. */
export interface RelayLink {
  readonly send: (line: string) => void;
  readonly close: () => void;
}

export interface RelaySessionOptions {
  /** Called once per message, in order, never twice for the same message. */
  readonly onMessage: (message: RelayMessage) => void;
  /** Unacknowledged bytes allowed before send throws. */
  readonly maxBufferedBytes?: number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024 * 1024;
/** Send a bare ack after this many unacknowledged incoming messages. */
const ACK_EVERY = 32;

export class RelaySession {
  private nextSeq = 1;
  private lastReceived = 0;
  private unackedSinceAck = 0;
  private bufferedBytes = 0;
  private readonly outbox: Array<{ readonly seq: number; readonly line: string }> = [];
  private link: RelayLink | null = null;
  /** True after the peer's hello on the current link: until then, only buffer. */
  private ready = false;
  private readonly options: RelaySessionOptions;

  constructor(options: RelaySessionOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.link !== null && this.ready;
  }

  /** Queues a message; it is delivered once, now or after a reconnect. */
  send(message: RelayMessage): void {
    const seq = this.nextSeq++;
    const line = JSON.stringify({ t: "data", s: seq, a: this.lastReceived, m: message });
    this.bufferedBytes += line.length;
    const max = this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    if (this.bufferedBytes > max) {
      throw new Error(`Relay buffer is over ${max} bytes; the other end stopped reading.`);
    }
    this.outbox.push({ seq, line });
    if (this.connected) this.write(line);
    this.unackedSinceAck = 0;
  }

  /**
   * Starts using a new connection. The caller then feeds every received line
   * to `receive` and calls `detach` when it closes. `token` goes in the hello
   * so the relay can check it before trusting anything else.
   */
  attach(link: RelayLink, token?: string): void {
    this.link?.close();
    this.link = link;
    this.ready = false;
    link.send(
      JSON.stringify({
        t: "hello",
        a: this.lastReceived,
        ...(token === undefined ? {} : { token }),
      } satisfies Frame),
    );
  }

  /** The connection closed; keep everything for the next one. */
  detach(link: RelayLink): void {
    if (this.link !== link) return;
    this.link = null;
    this.ready = false;
  }

  /** Feeds one received line. Returns the hello token, if this line was a hello. */
  receive(link: RelayLink, line: string): { readonly helloToken?: string | undefined } {
    if (this.link !== link) return {};
    const frame = JSON.parse(line) as Frame;
    this.dropAcked(frame.a);
    if (frame.t === "hello") {
      this.ready = true;
      for (const entry of this.outbox) this.write(entry.line);
      return { helloToken: frame.token };
    }
    if (frame.t === "data" && frame.s !== undefined && frame.m !== undefined) {
      if (frame.s <= this.lastReceived) return {};
      if (frame.s !== this.lastReceived + 1) {
        // A gap means the link lost frames without closing; force a resync.
        link.close();
        this.detach(link);
        return {};
      }
      this.lastReceived = frame.s;
      this.options.onMessage(frame.m);
      this.unackedSinceAck += 1;
      if (this.unackedSinceAck >= ACK_EVERY) this.ack();
    }
    return {};
  }

  /** Sends a bare ack so the peer can free its buffer. */
  ack(): void {
    this.unackedSinceAck = 0;
    if (this.connected) this.write(JSON.stringify({ t: "ack", a: this.lastReceived }));
  }

  private dropAcked(ack: number): void {
    while (this.outbox.length > 0 && this.outbox[0]!.seq <= ack) {
      this.bufferedBytes -= this.outbox.shift()!.line.length;
    }
  }

  private write(line: string): void {
    try {
      this.link?.send(line);
    } catch {
      // The socket is closing; the frame stays in the outbox for the next link.
    }
  }
}
