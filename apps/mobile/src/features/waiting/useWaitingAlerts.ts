import { useAtomValue } from "@effect/atom-react";
import { createWaitingAlertGate, waitingItemKeys } from "@t3tools/shared/waitingAlerts";
import { AsyncResult } from "effect/reactivity";
import { useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { useEnvironments } from "../../state/environments";
import {
  useLoadedProjectTeamEnvironmentIds,
  useProjectManagerEntries,
} from "../../state/projectTeam";
import { mobilePreferencesAtom } from "../../state/preferences";

export function useWaitingEntries() {
  const { environments } = useEnvironments();
  return useProjectManagerEntries(environments.map((environment) => environment.environmentId));
}

export function useWaitingAlerts() {
  const { environments } = useEnvironments();
  const environmentIds = environments.map((environment) => environment.environmentId);
  const entries = useProjectManagerEntries(environmentIds);
  const loadedEnvironmentIds = useLoadedProjectTeamEnvironmentIds(environmentIds);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const soundEnabled =
    !AsyncResult.isSuccess(preferences) || preferences.value.waitingSoundEnabled !== false;
  const enabled = useRef(soundEnabled);
  enabled.current = soundEnabled;
  const player = useAudioPlayer(require("../../../assets/notification-input.mp3"));
  const gate = useRef(
    createWaitingAlertGate({ coalesceMs: 3000, cooldownMs: 30000, now: Date.now }),
  );
  const { byEnvironment, total } = waitingItemKeys(entries);

  useEffect(() => {
    void Notifications.setBadgeCountAsync(total).catch((error) =>
      console.warn("Could not update waiting badge", error),
    );
  }, [total]);

  useEffect(() => {
    const deadline = gate.current.update(
      new Map(loadedEnvironmentIds.map((id) => [id, byEnvironment.get(id) ?? new Set<string>()])),
    );
    if (deadline === null) {
      return;
    }
    const timer = setTimeout(
      () => {
        if (!gate.current.flush()) {
          return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch((error) =>
          console.warn("Could not play waiting haptic", error),
        );
        if (enabled.current) {
          void player
            .seekTo(0)
            .then(() => player.play())
            .catch((error) => console.warn("Could not play waiting sound", error));
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [entries, loadedEnvironmentIds, player]);
}
