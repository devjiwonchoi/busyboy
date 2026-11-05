import type {
  ComputerUseAppGrant,
  ComputerUsePermissionKind,
  ComputerUseSettingsStatus,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { COMPUTER_USE_ALWAYS_ALLOW_DAYS } from "@t3tools/contracts";
import { AppWindowIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { isMacPlatform } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** How often the section re-reads the helper's grants while it is open. */
export const COMPUTER_USE_STATUS_POLL_MS = 2_000;

const formatGrantDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export const COMPUTER_USE_UNSUPPORTED_MESSAGE =
  "Computer Use is available on macOS 14 or later in the BusyBoy desktop app for now.";

export interface ComputerUseSettingValues {
  readonly enableAgentComputerUse: boolean;
  readonly computerUseAppGrants: ReadonlyArray<ComputerUseAppGrant>;
  readonly computerUseScreenshots: boolean;
  readonly computerUseExperimentalPointer: boolean;
}

export interface ComputerUseSettingsViewProps {
  /** Null until the first status arrives and says whether this Mac can run it. */
  readonly supported: boolean | null;
  readonly settings: ComputerUseSettingValues;
  readonly status: ComputerUseSettingsStatus | null;
  readonly onUpdate: (patch: ServerSettingsPatch) => void;
  readonly onRequestPermission: (kind: ComputerUsePermissionKind) => void;
  readonly onOpenSystemSettings: (url: string) => void;
  readonly onRestartHelper: () => void;
  readonly restarting?: boolean;
  /** For tests; defaults to the current time. */
  readonly now?: number;
}

/**
 * Desktop app on a Mac, with a desktop backend that is not on an older macOS.
 * Null while a Mac desktop app still waits for its first status.
 */
export function isComputerUseSupported(input: {
  readonly isElectron: boolean;
  readonly platform: string;
  readonly status: ComputerUseSettingsStatus | null;
}): boolean | null {
  if (!input.isElectron || !isMacPlatform(input.platform)) return false;
  if (input.status === null) return null;
  return input.status.available && input.status.helper.reason !== "unsupported_platform";
}

const HELPER_STATE_LABELS = {
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  error: "Error",
} as const;

function GrantStatus({ ok, label }: { readonly ok: boolean; readonly label: string }) {
  return (
    <span
      className={ok ? "text-success-foreground" : "text-warning-foreground"}
      data-testid="computer-use-grant-status"
    >
      {label}
    </span>
  );
}

function PermissionRow({
  title,
  description,
  ok,
  okLabel,
  missingLabel,
  showActions,
  onRequest,
  onOpen,
}: {
  readonly title: string;
  readonly description: string;
  readonly ok: boolean | null;
  readonly okLabel: string;
  readonly missingLabel: string;
  readonly showActions: boolean;
  readonly onRequest: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <SettingsRow
      title={title}
      description={description}
      status={ok === null ? "Unknown" : <GrantStatus ok={ok} label={ok ? okLabel : missingLabel} />}
      control={
        showActions && ok !== true ? (
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={onRequest}>
              Request access
            </Button>
            <Button size="xs" variant="ghost" onClick={onOpen}>
              Open System Settings
            </Button>
          </div>
        ) : null
      }
    />
  );
}

export function ComputerUseSettingsView({
  supported,
  settings,
  status,
  onUpdate,
  onRequestPermission,
  onOpenSystemSettings,
  onRestartHelper,
  restarting = false,
  now: nowProp,
}: ComputerUseSettingsViewProps) {
  if (supported === null) {
    // Neutral until we know, so older macOS never flashes the full section.
    return (
      <SettingsSection id="computer-use" title="Computer Use">
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">Checking…</p>
      </SettingsSection>
    );
  }
  if (!supported) {
    return (
      <SettingsSection id="computer-use" title="Computer Use">
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          {COMPUTER_USE_UNSUPPORTED_MESSAGE}
        </p>
      </SettingsSection>
    );
  }

  const enabled = settings.enableAgentComputerUse;
  const permissions = status?.permissions ?? null;
  const screenRecording = permissions === null ? null : permissions.screenRecording === "granted";
  const urls = status?.settingsUrls;
  const helper = status?.helper ?? null;
  const now = nowProp ?? Date.now();
  // Expired grants no longer count, so they are not listed.
  const grants = settings.computerUseAppGrants.filter((grant) => Date.parse(grant.expiresAt) > now);

  return (
    <SettingsSection id="computer-use" title="Computer Use">
      <SettingsRow
        id={searchableSetting("computer-use").id}
        title="Let agents use Mac apps"
        description="Agents can read and operate the apps you approve in the background, without moving your pointer or switching apps."
        control={
          <Switch
            aria-label="Let agents use Mac apps"
            checked={enabled}
            onCheckedChange={(checked) => onUpdate({ enableAgentComputerUse: checked })}
          />
        }
      />
      {enabled ? (
        <>
          <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
            These grants appear in System Settings as “BusyBoy Computer Use”, not BusyBoy.
          </p>
          <PermissionRow
            title="Accessibility"
            description="Required. Lets BusyBoy read and operate app windows."
            ok={permissions === null ? null : permissions.accessibility === "granted"}
            okLabel="Granted"
            missingLabel="Not granted"
            showActions={urls !== undefined}
            onRequest={() => onRequestPermission("accessibility")}
            onOpen={() => urls && onOpenSystemSettings(urls.accessibility)}
          />
          <PermissionRow
            title="Screen Recording"
            description="Optional. Only needed for window screenshots."
            ok={screenRecording}
            okLabel="Granted"
            missingLabel="Not granted"
            showActions={urls !== undefined}
            onRequest={() => onRequestPermission("screen_recording")}
            onOpen={() => urls && onOpenSystemSettings(urls.screenRecording)}
          />
          <PermissionRow
            title="Stop with Esc"
            description="Press Esc, or use the app yourself, to stop the agent. Needs Input Monitoring."
            ok={permissions === null ? null : permissions.stopMonitor === "available"}
            okLabel="Available"
            missingLabel="Unavailable"
            showActions={urls !== undefined}
            onRequest={() => onRequestPermission("input_monitoring")}
            onOpen={() => urls && onOpenSystemSettings(urls.inputMonitoring)}
          />
          <SettingsRow
            title="Always allowed apps"
            description={`Agents use these apps without asking, only in the project shown, for ${COMPUTER_USE_ALWAYS_ALLOW_DAYS} days.`}
          >
            {grants.length === 0 ? (
              <p className="pb-1 text-xs text-muted-foreground">
                Apps you always allow in a project will appear here.
              </p>
            ) : (
              <ul className="space-y-1 pb-1" aria-label="Always allowed apps">
                {grants.map((grant) => {
                  const label = `${grant.appName} in ${grant.projectName}`;
                  return (
                    <li
                      key={`${grant.projectId}:${grant.bundleId}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{label}</span>
                          <span className="truncate text-muted-foreground">
                            {`${grant.bundleId} · until ${formatGrantDate(grant.expiresAt)}`}
                          </span>
                        </span>
                      </span>
                      <Button
                        size="xs"
                        variant="ghost-destructive"
                        aria-label={`Remove ${label}`}
                        onClick={() =>
                          onUpdate({
                            computerUseAppGrants: grants.filter(
                              (other) =>
                                other.bundleId !== grant.bundleId ||
                                other.projectId !== grant.projectId,
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SettingsRow>
          <SettingsRow
            title="Include screenshots"
            description={
              screenRecording === false
                ? "Needs Screen Recording for BusyBoy Computer Use."
                : "Agents also see a picture of the window they read."
            }
            control={
              <Switch
                aria-label="Include screenshots"
                disabled={screenRecording === false}
                checked={settings.computerUseScreenshots && screenRecording !== false}
                onCheckedChange={(checked) => onUpdate({ computerUseScreenshots: checked })}
              />
            }
          />
          <SettingsRow
            title="Experimental: background pointer clicks"
            description="Lets agents click inside apps that don't expose accessibility actions, such as web content in Chromium apps, without moving your pointer. Uses a private macOS feature that may stop working after macOS updates, and some apps ignore background clicks."
            control={
              <Switch
                aria-label="Experimental: background pointer clicks"
                checked={settings.computerUseExperimentalPointer}
                onCheckedChange={(checked) => onUpdate({ computerUseExperimentalPointer: checked })}
              />
            }
          />
          <SettingsRow
            title="Helper"
            description={
              helper === null
                ? "Checking…"
                : `${HELPER_STATE_LABELS[helper.state]}${helper.reason ? ` · ${helper.detail ?? helper.reason}` : ""}`
            }
            control={
              <Button size="xs" variant="outline" disabled={restarting} onClick={onRestartHelper}>
                Restart helper
              </Button>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Reads the desktop helper's status while mounted: on mount, on window focus,
 * and every two seconds. Reading it starts the helper while enabled.
 */
export function ComputerUseSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const options = { reportFailure: false, reportDefect: false };
  const readStatus = useAtomCommand(serverEnvironment.computerUseStatus, options);
  const requestPermission = useAtomCommand(serverEnvironment.computerUseRequestPermission, options);
  const restartHelper = useAtomCommand(serverEnvironment.computerUseRestartHelper, options);
  const [status, setStatus] = useState<ComputerUseSettingsStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const readStatusRef = useRef(readStatus);
  readStatusRef.current = readStatus;
  const enabled = settings.enableAgentComputerUse;
  const platformOk = isElectron && isMacPlatform(navigator.platform);

  useEffect(() => {
    if (environmentId === null || !platformOk) return;
    let cancelled = false;
    // Opening or focusing settings starts the helper so its grants show; the
    // poll only reads, so an open settings page never keeps the helper awake.
    const refresh = (start: boolean) => {
      void readStatusRef
        .current({ environmentId, input: start ? { start } : {} })
        .then((result) => {
          if (!cancelled && result._tag === "Success") setStatus(result.value);
        });
    };
    const refreshAndStart = () => refresh(true);
    refreshAndStart();
    const interval = window.setInterval(() => refresh(false), COMPUTER_USE_STATUS_POLL_MS);
    window.addEventListener("focus", refreshAndStart);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshAndStart);
    };
  }, [environmentId, platformOk, enabled]);

  return (
    <ComputerUseSettingsView
      supported={isComputerUseSupported({ isElectron, platform: navigator.platform, status })}
      settings={settings}
      status={status}
      restarting={restarting}
      onUpdate={updateSettings}
      onRequestPermission={(kind) => {
        if (environmentId === null) return;
        void requestPermission({ environmentId, input: { kind } });
      }}
      onOpenSystemSettings={(url) => void ensureLocalApi().shell.openExternal(url)}
      onRestartHelper={() => {
        if (environmentId === null) return;
        setRestarting(true);
        void restartHelper({ environmentId, input: {} }).then((result) => {
          setRestarting(false);
          if (result._tag === "Success") setStatus(result.value);
        });
      }}
    />
  );
}
