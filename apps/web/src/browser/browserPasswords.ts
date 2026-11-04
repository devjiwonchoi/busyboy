import type {
  BrowserLoginSummary,
  BrowserNeverSaveEntry,
  BrowserPasswordsStatus,
  DesktopBrowserPasswordsBridge,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

/**
 * Saved passwords live in the desktop app. Read on every call rather than
 * once at import so tests (and late preload injection) see the current bridge.
 */
export function readBrowserPasswordsBridge(): DesktopBrowserPasswordsBridge | null {
  return typeof window === "undefined" ? null : (window.desktopBridge?.browserPasswords ?? null);
}

/** Calls `listener` whenever the vault for `profileId` changes. */
export function useBrowserPasswordsChanged(profileId: string | null, listener: () => void): void {
  const onChanged = useEffectEvent(listener);
  useEffect(() => {
    const bridge = readBrowserPasswordsBridge();
    if (!bridge || profileId === null) return;
    return bridge.onChanged((event) => {
      if (event.profileId === profileId) onChanged();
    });
  }, [profileId]);
}

/**
 * Loads `read(bridge, profileId)` for a profile and reloads it on every vault
 * change. `null` until the first answer for the current key arrives.
 */
function useVaultQuery<A>(
  profileId: string | null,
  key: string,
  read: (bridge: DesktopBrowserPasswordsBridge, profileId: string) => Promise<A>,
  fallback: A,
): A | null {
  const [state, setState] = useState<{ readonly key: string | null; readonly value: A | null }>({
    key: null,
    value: null,
  });
  const [revision, setRevision] = useState(0);
  const readEvent = useEffectEvent(read);
  useBrowserPasswordsChanged(profileId, () => setRevision((current) => current + 1));
  const fullKey = `${profileId}\0${key}`;

  useEffect(() => {
    const bridge = readBrowserPasswordsBridge();
    if (!bridge || profileId === null) return;
    let cancelled = false;
    readEvent(bridge, profileId)
      .then((value) => {
        if (!cancelled) setState({ key: fullKey, value });
      })
      .catch(() => {
        if (!cancelled) setState({ key: fullKey, value: fallback });
      });
    return () => {
      cancelled = true;
    };
  }, [fallback, fullKey, profileId, revision]);

  return profileId !== null && state.key === fullKey ? state.value : null;
}

const STATUS_READ_FAILED: BrowserPasswordsStatus = {
  available: false,
  reason: "databaseUnavailable",
  touchIdAvailable: false,
};

/** `null` while loading. */
export function useBrowserPasswordsStatus(profileId: string | null): BrowserPasswordsStatus | null {
  return useVaultQuery(
    profileId,
    "status",
    (bridge, id) => bridge.status({ profileId: id }),
    STATUS_READ_FAILED,
  );
}

const NO_LOGINS: ReadonlyArray<BrowserLoginSummary> = [];

/** Saved logins matching `query` (site or username); `null` while loading. */
export function useBrowserPasswordsList(
  profileId: string | null,
  query: string,
  enabled = true,
): ReadonlyArray<BrowserLoginSummary> | null {
  return useVaultQuery(
    enabled ? profileId : null,
    `list\0${query}`,
    (bridge, id) => bridge.list({ profileId: id, ...(query.length > 0 ? { query } : {}) }),
    NO_LOGINS,
  );
}

const NO_NEVER_SAVE: ReadonlyArray<BrowserNeverSaveEntry> = [];

export function useBrowserNeverSaveList(
  profileId: string | null,
  enabled = true,
): ReadonlyArray<BrowserNeverSaveEntry> {
  return (
    useVaultQuery(
      enabled ? profileId : null,
      "neverSave",
      (bridge, id) => bridge.neverSave.list({ profileId: id }),
      NO_NEVER_SAVE,
    ) ?? NO_NEVER_SAVE
  );
}

/**
 * Empties a profile's vault before the profile is removed so it isn't left
 * behind. Deleting saved logins runs the device check in main; `cancelled`
 * means the user declined and the profile must stay. A vault that can't be
 * opened (no secure storage, unreadable file) has nothing this UI can delete.
 */
export async function deleteBrowserProfilePasswords(
  bridge: Pick<DesktopBrowserPasswordsBridge, "list" | "deleteAll" | "neverSave"> | null,
  profileId: string,
): Promise<"deleted" | "cancelled" | "none"> {
  if (!bridge) return "none";
  const logins = await bridge.list({ profileId }).catch(() => null);
  if (logins === null) return "none";
  let outcome: "deleted" | "none" = "none";
  if (logins.length > 0) {
    const result = await bridge.deleteAll({ profileId });
    if (result.kind === "cancelled") return "cancelled";
    outcome = "deleted";
  }
  const neverSave = await bridge.neverSave.list({ profileId });
  if (neverSave.length > 0) {
    await bridge.neverSave.remove({ profileId, ids: neverSave.map((entry) => entry.id) });
  }
  return outcome;
}
