import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_SERVER_SETTINGS, type ComputerUsePermissions } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";

const permissionLabel = (granted: boolean) => (granted ? "On" : "Off");

/**
 * Busyboy Computer Use, a separate app, holds the macOS permissions, so the
 * agents Busyboy starts do not inherit them. These settings live on the
 * desktop app's own backend, the one that can operate this Mac.
 */
export function ComputerUseSettings() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const keepDisplayAwake = usePrimarySettings((settings) => settings.computerUseKeepDisplayAwake);
  const allowedApps = usePrimarySettings((settings) => settings.computerUseAllowedApps);
  const updateSettings = useUpdatePrimarySettings();
  const getPermissions = useAtomCommand(serverEnvironment.getComputerUsePermissions, {
    label: "check computer-use permissions",
    reportFailure: false,
    reportDefect: false,
  });
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async (input: { readonly request: boolean }) => {
    if (environmentId === null) {
      return;
    }
    setChecking(true);
    const result = await getPermissions({ environmentId, input }).finally(() => setChecking(false));
    if (result._tag === "Success") {
      setPermissions(result.value);
      setError(null);
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not check the permissions.");
  };

  // The user grants permissions in System Settings, so check again on return.
  const checkSilently = useEffectEvent(() => void check({ request: false }));
  useEffect(() => {
    checkSilently();
    window.addEventListener("focus", checkSilently);
    return () => window.removeEventListener("focus", checkSilently);
  }, [environmentId]);

  const missing =
    permissions !== null && !(permissions.accessibility && permissions.screenRecording);
  const rows = (
    <>
      <SettingsRow
        {...searchableSetting("computer-use-permissions")}
        description={
          <>
            Busyboy Computer Use is the app that operates this Mac for agents, so Busyboy itself
            needs no access. Turn it on in System Settings › Privacy & Security › Accessibility and
            Screen Recording.
          </>
        }
        status={
          error ??
          (permissions === null
            ? "Checking…"
            : `Accessibility: ${permissionLabel(permissions.accessibility)} · Screen Recording: ${permissionLabel(permissions.screenRecording)}`)
        }
        control={
          missing ? (
            <Button
              size="compact"
              variant="outline"
              disabled={checking}
              onClick={() => void check({ request: true })}
            >
              Ask macOS
            </Button>
          ) : null
        }
      />
      <SettingsRow
        {...searchableSetting("computer-use-keep-display-awake")}
        description="Keeps the display on while an agent uses the computer, so it can finish while you are away. A Mac whose display stays on does not lock, so anyone nearby can use it."
        resetAction={
          keepDisplayAwake !== DEFAULT_SERVER_SETTINGS.computerUseKeepDisplayAwake ? (
            <SettingResetButton
              label="keep display awake"
              onClick={() =>
                updateSettings({
                  computerUseKeepDisplayAwake: DEFAULT_SERVER_SETTINGS.computerUseKeepDisplayAwake,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Keep display awake for computer use"
            checked={keepDisplayAwake}
            onCheckedChange={(checked) =>
              updateSettings({ computerUseKeepDisplayAwake: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("computer-use-allowed-apps")}
        description={
          allowedApps.length === 0
            ? "None yet. Choose Always allow when an agent asks to use an app."
            : "Agents can use these apps without asking. Remove one to be asked again."
        }
      >
        {allowedApps.length === 0 ? null : (
          <ul className="flex flex-col gap-1 px-4 pb-3 sm:px-5">
            {allowedApps.map((bundleId) => (
              <li key={bundleId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-mono text-xs">{bundleId}</span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Remove ${bundleId}`}
                  onClick={() =>
                    updateSettings({
                      computerUseAllowedApps: allowedApps.filter((id) => id !== bundleId),
                    })
                  }
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </>
  );

  return (
    <SettingsSection id="computer-use" title="Computer use">
      <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
        Agents ask before they use each app. An agent in Full access mode can run any program,
        including ones that control the Mac without asking, so give full access only to agents you
        trust with your computer.
      </p>
      {permissions?.available === false ? (
        <SettingsUnavailableGroup message="Only available in the Busyboy desktop app on macOS.">
          {rows}
        </SettingsUnavailableGroup>
      ) : (
        rows
      )}
    </SettingsSection>
  );
}
