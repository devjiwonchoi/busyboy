import { describe, expect, it } from "@effect/vitest";

import { encodeHelperFrame, HelperFrameDecoder, MAX_FRAME_BYTES } from "./HelperFraming.ts";

describe("HelperFraming", () => {
  it("round-trips messages split across arbitrary chunks", () => {
    const frames = new Uint8Array([
      ...encodeHelperFrame({ id: 1, method: "hello" }),
      ...encodeHelperFrame({ method: "stopped", params: { reason: "user_escape" } }),
    ]);
    expect(Array.from(frames.slice(0, 4))).toEqual([0, 0, 0, 25]);

    const decoder = new HelperFrameDecoder();
    const received: Array<unknown> = [];
    for (let index = 0; index < frames.length; index += 5) {
      received.push(...decoder.push(frames.slice(index, index + 5)));
    }
    expect(received).toEqual([
      { id: 1, method: "hello" },
      { method: "stopped", params: { reason: "user_escape" } },
    ]);
  });

  it("refuses oversized frames", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => new HelperFrameDecoder().push(header)).toThrow(/exceeds the limit/);
  });
});
