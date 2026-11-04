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

/** Incremental decoder: push socket chunks, get whole JSON messages back. */
export class HelperFrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Array<unknown> {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);

    const messages: Array<unknown> = [];
    let offset = 0;
    while (joined.length - offset >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0, false);
      if (length > MAX_FRAME_BYTES) {
        throw new HelperFrameError(`frame of ${length} bytes exceeds the limit`);
      }
      if (joined.length - offset - 4 < length) {
        break;
      }
      const body = joined.subarray(offset + 4, offset + 4 + length);
      messages.push(JSON.parse(decoder.decode(body)));
      offset += 4 + length;
    }
    this.buffer = joined.slice(offset);
    return messages;
  }
}
