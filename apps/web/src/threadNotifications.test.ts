import { afterEach, expect, it, vi } from "vite-plus/test";
import { playNotificationSound, unlockNotificationAudio } from "./threadNotifications";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("suppresses the waiting alert sound after an immediate thread input sound", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const start = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = async () => {};
      decodeAudioData = async () => ({});
      createBufferSource = () => ({ buffer: null, connect: vi.fn(), start });
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
  unlockNotificationAudio();
  await playNotificationSound("input", () => true);
  vi.setSystemTime(3000);
  await playNotificationSound("input", () => true);
  expect(start).toHaveBeenCalledTimes(1);
  vi.setSystemTime(5000);
  await playNotificationSound("input", () => true);
  expect(start).toHaveBeenCalledTimes(2);
});
