import { createWaitingAlertGate, waitingItemKeys } from "@t3tools/shared/waitingAlerts";
import { useEffect, useRef, useState } from "react";
import { getClientSettings } from "../hooks/useSettings";
import { useDirectorInbox } from "../state/director";
import { useEnvironmentIds } from "../state/environments";
import { useLoadedProjectTeamEnvironmentIds, useProjectManagerEntries } from "../state/projectTeam";
import {
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
} from "../threadNotifications";

export function useWaitingPulse(count: number) {
  const previous = useRef(count);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const increased = count > previous.current;
    previous.current = count;
    if (!increased) {
      return;
    }
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), 1200);
    return () => {
      clearTimeout(timer);
      setPulse(false);
    };
  }, [count]);
  return pulse ? "true" : undefined;
}

export function WaitingAlerts() {
  const environmentIds = useEnvironmentIds();
  const entries = useProjectManagerEntries(environmentIds);
  const loadedEnvironmentIds = useLoadedProjectTeamEnvironmentIds(environmentIds);
  const gate = useRef(
    createWaitingAlertGate({ coalesceMs: 3000, cooldownMs: 30000, now: Date.now }),
  );
  const { byEnvironment, total } = waitingItemKeys(entries);
  useEffect(() => {
    setNotificationBadge(total);
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
        if (
          !gate.current.flush() ||
          (document.visibilityState === "visible" && document.hasFocus())
        ) {
          return;
        }
        const currentMode = getClientSettings().notificationMode;
        if (hasNotificationSound(currentMode)) {
          void playNotificationSound("input", () =>
            hasNotificationSound(getClientSettings().notificationMode),
          );
        }
        if (currentMode !== "off") {
          void window.desktopBridge
            ?.requestAttention?.()
            .catch((error) => console.warn("Could not request attention", error));
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [entries, loadedEnvironmentIds]);
  return null;
}

/** Share the title owner with the root branding sync. */
export function WaitingTitle({ title }: { title: string }) {
  const { total } = useDirectorInbox();
  useEffect(() => {
    document.title = total > 0 ? `(${total}) ${title}` : title;
  }, [title, total]);
  return null;
}
