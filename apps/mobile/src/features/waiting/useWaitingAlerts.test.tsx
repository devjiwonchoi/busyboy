// @vitest-environment jsdom
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  loaded: false,
  soundEnabled: true,
  entries: [] as { environmentId: string; summary: ProjectTeamAttentionSummary }[],
  badge: vi.fn(async () => true),
  haptic: vi.fn(async () => {}),
  player: { seekTo: vi.fn(async () => {}), play: vi.fn() },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ waitingSoundEnabled: harness.soundEnabled }),
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "local" }] }),
}));
vi.mock("../../state/projectTeam", () => ({
  useProjectManagerEntries: () => harness.entries,
  useLoadedProjectTeamEnvironmentIds: () => (harness.loaded ? ["local"] : []),
}));
vi.mock("expo-audio", () => ({ useAudioPlayer: () => harness.player }));
vi.mock("expo-haptics", () => ({
  notificationAsync: harness.haptic,
  NotificationFeedbackType: { Warning: "warning" },
}));
vi.mock("expo-notifications", () => ({ setBadgeCountAsync: harness.badge }));

import { useWaitingAlerts } from "./useWaitingAlerts";

function Harness() {
  useWaitingAlerts();
  return null;
}

let root: Root;
let container: HTMLDivElement;

function publish(count: number) {
  harness.loaded = true;
  harness.entries = [
    {
      environmentId: "local",
      summary: {
        decisionCards: Array.from({ length: count }, (_, index) => ({
          item: { id: `card-${index}`, answeredAt: null, supersededAt: null },
        })),
        waitingThreads: [],
      } as unknown as ProjectTeamAttentionSummary,
    },
  ];
  root.render(<Harness />);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("require", () => "notification-input.mp3");
  harness.loaded = false;
  harness.entries = [];
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "baselines loaded items and alerts once for new items (sound=%s)",
  async (soundEnabled) => {
    harness.soundEnabled = soundEnabled;
    await act(async () => root.render(<Harness />));
    await act(async () => publish(2));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(harness.haptic).toHaveBeenCalledTimes(0);
    expect(harness.player.play).toHaveBeenCalledTimes(0);
    expect(harness.badge).toHaveBeenLastCalledWith(2);

    await act(async () => publish(3));
    expect(harness.badge).toHaveBeenLastCalledWith(3);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(harness.haptic).toHaveBeenCalledExactlyOnceWith("warning");
    expect(harness.player.seekTo).toHaveBeenCalledTimes(soundEnabled ? 1 : 0);
    expect(harness.player.play).toHaveBeenCalledTimes(soundEnabled ? 1 : 0);
  },
);
