/**
 * What the Computer Use settings section reads and does: status with the
 * helper's own permission grants, permission prompts, and "Restart helper".
 */
import {
  COMPUTER_USE_SETTINGS_URLS,
  ComputerUseError,
  ComputerUsePermissionsStatus,
  DESKTOP_COMPUTER_USE_METHODS,
  type ComputerUsePermissionKind,
  type ComputerUseSettingsStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as DesktopComputerUseChannel from "./DesktopComputerUseChannel.ts";

const STATUS_TIMEOUT_MS = 10_000;
const decodePermissions = Schema.decodeUnknownEffect(ComputerUsePermissionsStatus);

/**
 * Without `start`, never starts the helper or extends its idle time: a stopped
 * helper reports its cached status, a running one also its grants. With
 * `start` (settings:write, the settings section) it starts lazily while enabled.
 */
export const readStatus = Effect.fn("computerUse.settings.readStatus")(function* (
  options: { readonly start?: boolean } = {},
) {
  const channel = yield* DesktopComputerUseChannel.DesktopComputerUseChannel;
  const settings = yield* ServerSettings.ServerSettingsService;
  const { enableAgentComputerUse: enabled } = yield* settings.getSettings;
  const base = { enabled, available: channel.available, settingsUrls: COMPUTER_USE_SETTINGS_URLS };
  const cached = yield* channel.status;
  if (!channel.available || !enabled || (!options.start && cached.state !== "running")) {
    return { ...base, helper: cached } satisfies ComputerUseSettingsStatus;
  }
  const permissions = yield* channel
    .request(
      "permissions.status",
      {},
      { timeoutMs: STATUS_TIMEOUT_MS, ...(options.start ? {} : { passive: true }) },
    )
    .pipe(Effect.flatMap(decodePermissions), Effect.option);
  // Read after the request: its status lines arrive before its response.
  const helper = yield* channel.status;
  return {
    ...base,
    helper,
    ...(Option.isSome(permissions) ? { permissions: permissions.value } : {}),
  } satisfies ComputerUseSettingsStatus;
});

/** Shows the system prompt for one grant; only the settings UI calls this. */
export const requestPermission = Effect.fn("computerUse.settings.requestPermission")(function* (
  kind: ComputerUsePermissionKind,
) {
  const channel = yield* DesktopComputerUseChannel.DesktopComputerUseChannel;
  const settings = yield* ServerSettings.ServerSettingsService;
  const { enableAgentComputerUse } = yield* settings.getSettings;
  if (!enableAgentComputerUse) {
    return yield* ComputerUseError.unavailable("disabled", "computer use is turned off");
  }
  yield* channel.request("permissions.request", { kind }, { timeoutMs: STATUS_TIMEOUT_MS });
  return {};
});

/** Clears a crash cutoff and starts the helper again. */
export const restartHelper = Effect.fn("computerUse.settings.restartHelper")(function* () {
  const channel = yield* DesktopComputerUseChannel.DesktopComputerUseChannel;
  const settings = yield* ServerSettings.ServerSettingsService;
  const { enableAgentComputerUse } = yield* settings.getSettings;
  if (enableAgentComputerUse) {
    // A failed restart shows up in the status below.
    yield* channel
      .request(DESKTOP_COMPUTER_USE_METHODS.helperRestart, {}, { timeoutMs: STATUS_TIMEOUT_MS })
      .pipe(Effect.ignore);
  }
  return yield* readStatus({ start: true });
});
