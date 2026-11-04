import type {
  BrowserHistoryRecentEntry,
  BrowserHistoryStatus,
  DesktopBrowserHistoryBridge,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

/**
 * Browsing history lives in the desktop app. Read on every call rather than
 * once at import so tests (and late preload injection) see the current bridge.
 */
export function readBrowserHistoryBridge(): DesktopBrowserHistoryBridge | null {
  return typeof window === "undefined" ? null : (window.desktopBridge?.browserHistory ?? null);
}

/** Calls `listener` whenever history for `profileId` changes. */
export function useBrowserHistoryChanged(profileId: string | null, listener: () => void): void {
  const onChanged = useEffectEvent(listener);
  useEffect(() => {
    const bridge = readBrowserHistoryBridge();
    if (!bridge || profileId === null) return;
    return bridge.onChanged((event) => {
      if (event.profileId === profileId) onChanged();
    });
  }, [profileId]);
}

const NO_RECENTS: ReadonlyArray<BrowserHistoryRecentEntry> = [];

/**
 * Most recently visited distinct URLs for a profile. Pass `null` to skip the
 * bridge entirely (incognito, or outside the desktop app).
 */
export function useBrowserHistoryRecent(
  profileId: string | null,
  limit: number,
): ReadonlyArray<BrowserHistoryRecentEntry> {
  const [state, setState] = useState<{
    readonly profileId: string | null;
    readonly entries: ReadonlyArray<BrowserHistoryRecentEntry>;
  }>({ profileId: null, entries: NO_RECENTS });
  const [revision, setRevision] = useState(0);
  useBrowserHistoryChanged(profileId, () => setRevision((current) => current + 1));

  useEffect(() => {
    const bridge = readBrowserHistoryBridge();
    if (!bridge || profileId === null) return;
    let cancelled = false;
    bridge
      .recent({ profileId, limit })
      .then((entries) => {
        if (!cancelled) setState({ profileId, entries });
      })
      .catch(() => {
        if (!cancelled) setState({ profileId, entries: NO_RECENTS });
      });
    return () => {
      cancelled = true;
    };
  }, [limit, profileId, revision]);

  return profileId !== null && state.profileId === profileId ? state.entries : NO_RECENTS;
}

const UNKNOWN_STATUS: BrowserHistoryStatus = { available: true, deletionLocked: false };

export function useBrowserHistoryStatus(profileId: string | null): BrowserHistoryStatus {
  const [state, setState] = useState<{
    readonly profileId: string | null;
    readonly status: BrowserHistoryStatus;
  }>({ profileId: null, status: UNKNOWN_STATUS });
  const [revision, setRevision] = useState(0);
  useBrowserHistoryChanged(profileId, () => setRevision((current) => current + 1));

  useEffect(() => {
    const bridge = readBrowserHistoryBridge();
    if (!bridge || profileId === null) return;
    let cancelled = false;
    bridge
      .status({ profileId })
      .then((status) => {
        if (!cancelled) setState({ profileId, status });
      })
      .catch(() => {
        if (!cancelled)
          setState({ profileId, status: { available: false, deletionLocked: false } });
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, revision]);

  return state.profileId === profileId ? state.status : UNKNOWN_STATUS;
}

export function removeBrowserHistoryUrl(profileId: string, url: string): Promise<void> {
  const bridge = readBrowserHistoryBridge();
  return bridge ? bridge.remove({ profileId, urls: [url] }) : Promise.resolve();
}

/** Deletes every visit recorded for a profile, e.g. when the profile is removed. */
export function clearAllBrowserHistory(
  bridge: Pick<DesktopBrowserHistoryBridge, "clear"> | null,
  profileId: string,
): Promise<void> {
  if (!bridge) return Promise.resolve();
  return bridge.clear({ profileId, range: "all", dataTypes: ["history"], environmentIds: [] });
}
