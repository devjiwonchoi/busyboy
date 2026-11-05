import { describe, expect, it } from "@effect/vitest";

import { makeDeviceAuthGate } from "./DeviceAuth.ts";

const deps = (overrides: Partial<Parameters<typeof makeDeviceAuthGate>[0]> = {}) => {
  const calls: string[] = [];
  return {
    calls,
    gate: makeDeviceAuthGate({
      platform: "darwin",
      canPromptTouchID: () => true,
      promptTouchID: (reason) => {
        calls.push(`touch:${reason}`);
        return Promise.resolve();
      },
      confirm: ({ message, detail }) => {
        calls.push(`confirm:${message}:${detail}`);
        return Promise.resolve(true);
      },
      ...overrides,
    }),
  };
};

describe("DeviceAuthGate", () => {
  it("uses Touch ID with a reason naming the site", async () => {
    const { gate, calls } = deps();
    expect(await gate.authorize({ action: "reveal", site: "example.com" })).toBe(true);
    expect(calls).toEqual(["touch:reveal the saved password for example.com"]);
  });

  it("treats a cancelled Touch ID prompt as a silent no", async () => {
    const { gate } = deps({ promptTouchID: () => Promise.reject(new Error("cancelled")) });
    expect(await gate.authorize({ action: "copy", site: "example.com" })).toBe(false);
  });

  it("falls back to a confirm that says Touch ID is unavailable", async () => {
    const { gate, calls } = deps({ canPromptTouchID: () => false });
    expect(gate.touchIdAvailable()).toBe(false);
    expect(await gate.authorize({ action: "copy", site: "example.com" })).toBe(true);
    expect(calls).toEqual([
      "confirm:Touch ID unavailable:Confirm that you want to copy the saved password for example.com.",
    ]);
    expect(deps({ platform: "linux" }).gate.touchIdAvailable()).toBe(false);
  });
});
