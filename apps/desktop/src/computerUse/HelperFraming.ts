/**
 * Frames for the computer-use helper socket: a 4-byte big-endian length, then a
 * UTF-8 JSON body. Bodies over 16 MiB are refused on both sides.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class HelperFrameError extends Error {
  override readonly name = "HelperFrameError";
}

export function encodeHelperFrame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  if (body.length > MAX_FRAME_BYTES) {
    throw new HelperFrameError(`frame of ${body.length} bytes exceeds the limit`);
  }
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

/**
 * Incremental decoder: push socket chunks, get whole JSON messages back. Chunks
 * are kept as a list and each body is copied once, so a large frame arriving in
 * many small chunks costs linear time.
 */
export class HelperFrameDecoder {
  private chunks: Array<Uint8Array> = [];
  /** Index of the first unread chunk; consumed chunks are dropped in batches. */
  private head = 0;
  private buffered = 0;

  push(chunk: Uint8Array): Array<unknown> {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const messages: Array<unknown> = [];
    while (this.buffered >= 4) {
      const header = this.read(4, false);
      const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
      if (length > MAX_FRAME_BYTES) {
        throw new HelperFrameError(`frame of ${length} bytes exceeds the limit`);
      }
      if (this.buffered - 4 < length) break;
      this.read(4, true);
      messages.push(JSON.parse(decoder.decode(this.read(length, true))));
    }
    if (this.head > 0) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return messages;
  }

  /** The first `count` buffered bytes; a view when one chunk holds them, else one copy. */
  private read(count: number, consume: boolean): Uint8Array {
    const first = this.chunks[this.head]!;
    if (count === 0) return new Uint8Array(0);
    if (first.length >= count) {
      if (consume) this.advance(count);
      return first.subarray(0, count);
    }
    const out = new Uint8Array(count);
    let filled = 0;
    for (let index = this.head; filled < count; index += 1) {
      const part = this.chunks[index]!.subarray(0, count - filled);
      out.set(part, filled);
      filled += part.length;
    }
    if (consume) this.advance(count);
    return out;
  }

  private advance(count: number): void {
    this.buffered -= count;
    let left = count;
    while (left > 0) {
      const chunk = this.chunks[this.head]!;
      if (chunk.length <= left) {
        left -= chunk.length;
        this.head += 1;
      } else {
        this.chunks[this.head] = chunk.subarray(left);
        left = 0;
      }
    }
  }
}
