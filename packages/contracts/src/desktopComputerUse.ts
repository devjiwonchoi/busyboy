import * as Schema from "effect/Schema";

/**
 * The desktop↔server computer-use channel. The server never opens the helper
 * socket: it writes command lines to the desktop, which routes them to the
 * helper it supervises and writes back response, notification, and status
 * lines.
 */

/** Tool error codes. `invalid_frame`, `version_mismatch`, and `internal_error` are helper-level. */
export const ComputerUseErrorCode = Schema.Literals([
  "computer_use_unavailable",
  "permission_required",
  "app_not_found",
  "app_launch_failed",
  "app_forbidden",
  "app_denied",
  "window_not_found",
  "stale_element",
  "element_not_found",
  "action_unsupported",
  "secure_field",
  "key_refused",
  "screen_locked",
  "stopped",
  "turn_inactive",
  "timeout",
  "invalid_argument",
  "invalid_frame",
  "version_mismatch",
  "internal_error",
]);
export type ComputerUseErrorCode = typeof ComputerUseErrorCode.Type;

/** `details.reason` of `computer_use_unavailable`. */
export const ComputerUseUnavailableReason = Schema.Literals([
  "disabled",
  "unsupported_platform",
  "desktop_unavailable",
  "desktop_disconnected",
  "helper_missing",
  "helper_not_bundled",
  "helper_signature_invalid",
  "helper_install_failed",
  "helper_start_failed",
  "helper_crashed",
  "helper_disconnected",
  "helper_unreachable",
  "helper_foreign_instance",
  "unsafe_socket_dir",
  "version_mismatch",
  "invalid_frame",
  "internal_error",
]);
export type ComputerUseUnavailableReason = typeof ComputerUseUnavailableReason.Type;

/**
 * Reasons that a retry cannot fix without the user acting. `helper_crashed` is
 * terminal only after the crash cutoff, so the desktop decides it per error.
 */
export const COMPUTER_USE_TERMINAL_REASONS: ReadonlySet<string> =
  new Set<ComputerUseUnavailableReason>([
    "disabled",
    "unsupported_platform",
    "helper_not_bundled",
    "helper_signature_invalid",
    "helper_foreign_instance",
    "unsafe_socket_dir",
    "version_mismatch",
  ]);

const errorFields = {
  code: ComputerUseErrorCode,
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Unknown),
  retryable: Schema.Boolean,
};

/** The wire shape of a helper or channel error. */
export const ComputerUseErrorObject = Schema.Struct(errorFields);
export type ComputerUseErrorObject = typeof ComputerUseErrorObject.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()(
  "ComputerUseError",
  errorFields,
) {
  static fromObject(error: ComputerUseErrorObject): ComputerUseError {
    return new ComputerUseError(error);
  }

  static unavailable(reason: ComputerUseUnavailableReason, message: string): ComputerUseError {
    return new ComputerUseError({
      code: "computer_use_unavailable",
      message,
      details: { reason },
      retryable: !COMPUTER_USE_TERMINAL_REASONS.has(reason),
    });
  }
}

export const ComputerUseGrantStatus = Schema.Literals(["granted", "not_granted"]);
export type ComputerUseGrantStatus = typeof ComputerUseGrantStatus.Type;

/** `permissions.status` from the helper. These grants belong to the helper, not BusyBoy. */
export const ComputerUsePermissionsStatus = Schema.Struct({
  accessibility: ComputerUseGrantStatus,
  screenRecording: ComputerUseGrantStatus,
  stopMonitor: Schema.Literals(["available", "unavailable"]),
});
export type ComputerUsePermissionsStatus = typeof ComputerUsePermissionsStatus.Type;

export const ComputerUsePermissionKind = Schema.Literals([
  "accessibility",
  "screen_recording",
  "input_monitoring",
]);
export type ComputerUsePermissionKind = typeof ComputerUsePermissionKind.Type;

export const COMPUTER_USE_SETTINGS_URLS = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
} as const;

export const ComputerUseSettingsUrls = Schema.Struct({
  accessibility: Schema.String,
  screenRecording: Schema.String,
  inputMonitoring: Schema.String,
});
export type ComputerUseSettingsUrls = typeof ComputerUseSettingsUrls.Type;

export const ComputerUseHelperState = Schema.Literals(["running", "stopped", "starting", "error"]);
export type ComputerUseHelperState = typeof ComputerUseHelperState.Type;

export const ComputerUseHelperStatus = Schema.Struct({
  state: ComputerUseHelperState,
  reason: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
export type ComputerUseHelperStatus = typeof ComputerUseHelperStatus.Type;

/** Methods the desktop answers itself instead of forwarding to the helper. */
export const DESKTOP_COMPUTER_USE_METHODS = {
  helperStatus: "helper.status",
  helperRestart: "helper.restart",
} as const;

/** `helper.status` result. */
export const DesktopComputerUseHelperInfo = Schema.Struct({
  status: ComputerUseHelperStatus,
  installedPath: Schema.optionalKey(Schema.String),
  installedVersion: Schema.optionalKey(Schema.String),
  helperVersion: Schema.optionalKey(Schema.String),
});
export type DesktopComputerUseHelperInfo = typeof DesktopComputerUseHelperInfo.Type;

/** Server → desktop, one JSON object per line. */
export const DesktopComputerUseCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("request"),
    id: Schema.Int,
    method: Schema.String,
    params: Schema.Unknown,
    /** Answer only from a running helper: never start it or extend its idle time. */
    passive: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("configure"), enabled: Schema.Boolean }),
]);
export type DesktopComputerUseCommand = typeof DesktopComputerUseCommand.Type;

/** Desktop → server, one JSON object per line. */
export const DesktopComputerUseEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("response"),
    id: Schema.Int,
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(ComputerUseErrorObject),
  }),
  Schema.Struct({
    type: Schema.Literal("notification"),
    method: Schema.String,
    params: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    state: ComputerUseHelperState,
    reason: Schema.optionalKey(Schema.String),
    detail: Schema.optionalKey(Schema.String),
  }),
]);
export type DesktopComputerUseEvent = typeof DesktopComputerUseEvent.Type;

/** `computerUse.status` for the settings section. */
export const ComputerUseSettingsStatus = Schema.Struct({
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  helper: ComputerUseHelperStatus,
  permissions: Schema.optionalKey(ComputerUsePermissionsStatus),
  settingsUrls: ComputerUseSettingsUrls,
});
export type ComputerUseSettingsStatus = typeof ComputerUseSettingsStatus.Type;
