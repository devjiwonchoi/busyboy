import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

import { APP_VERSION } from "../branding";

const STALE_BUNDLE_RELOAD_GUARD_KEY = "busyboy:stale-bundle-reloaded";

// A phone page can outlive a desktop restart and keep running the old bundle.
export function reloadOnceForNewerServer(input: {
  serverVersion: string | null | undefined;
  clientVersion?: string;
  isElectron?: boolean;
  isHostedStatic?: boolean;
  getStorage?: () => Storage;
  reload?: () => void;
}): boolean {
  if (input.isElectron || input.isHostedStatic) {
    return false;
  }

  const clientVersion = (input.clientVersion ?? APP_VERSION).trim();
  const serverVersion = input.serverVersion?.trim();
  if (
    !clientVersion ||
    !serverVersion ||
    clientVersion === "0.0.0" ||
    !parseSemver(clientVersion) ||
    !parseSemver(serverVersion) ||
    compareSemverVersions(serverVersion, clientVersion) <= 0
  ) {
    return false;
  }

  const versionPair = `${clientVersion}->${serverVersion}`;
  try {
    const storage = input.getStorage ? input.getStorage() : window.sessionStorage;
    if (storage.getItem(STALE_BUNDLE_RELOAD_GUARD_KEY) === versionPair) {
      return false;
    }
    storage.setItem(STALE_BUNDLE_RELOAD_GUARD_KEY, versionPair);
  } catch {
    // Without a persistent guard, reloading could loop if stale assets are served.
    return false;
  }

  const reload = input.reload ?? (() => window.location.reload());
  reload();
  return true;
}
