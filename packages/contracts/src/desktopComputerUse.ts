import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

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

// ---------------------------------------------------------------------------
// Agent tools (`computer_*`). Inputs are the MCP arguments (snake_case);
// outputs follow the helper's camelCase results.

/** `details.reason` of `app_forbidden`. */
export const ComputerUseForbiddenReason = Schema.Literals([
  "password_manager",
  "terminal",
  "busyboy",
  "system_security",
  "private_window",
  "unidentified_app",
  "elevated_window",
  "automation",
  "file_manager",
]);
export type ComputerUseForbiddenReason = typeof ComputerUseForbiddenReason.Type;

/** `details.reason` of `stopped`. */
export const ComputerUseStopReason = Schema.Literals([
  "user_escape",
  "user_input",
  "client_stop",
  "screen_locked",
]);
export type ComputerUseStopReason = typeof ComputerUseStopReason.Type;

export const COMPUTER_USE_DEFAULT_DEADLINE_MS = 10_000;
export const COMPUTER_USE_MAX_DEADLINE_MS = 60_000;
export const COMPUTER_USE_MAX_TYPE_CHARS = 10_000;
export const COMPUTER_USE_MAX_SCROLL_TIMES = 20;
export const COMPUTER_USE_MAX_INSTALLED_APPS = 300;

/** Never offered "Always allow": the user should decide each time. */
export const COMPUTER_USE_NO_ALWAYS_ALLOW_BUNDLE_IDS: ReadonlyArray<string> = [
  "com.apple.systempreferences",
  "com.apple.Settings",
];

/**
 * Browsers show pages anyone can write, so they are approved per thread at most.
 * Same list as the helper's private-window check (`forbidden.rs`).
 */
export const COMPUTER_USE_BROWSER_BUNDLE_PREFIXES: ReadonlyArray<string> = [
  "com.google.Chrome",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "company.thebrowser.Browser",
  "org.mozilla.firefox",
  "org.mozilla.nightly",
  "com.apple.Safari",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "org.chromium.Chromium",
  "app.zen-browser.zen",
  "com.kagi.kagimacOS",
];

/** Whether the approval card may offer "Always allow in this project" for this app. */
export const computerUseOffersAlwaysAllow = (bundleId: string): boolean => {
  const id = bundleId.toLowerCase();
  if (COMPUTER_USE_NO_ALWAYS_ALLOW_BUNDLE_IDS.some((entry) => entry.toLowerCase() === id)) {
    return false;
  }
  return !COMPUTER_USE_BROWSER_BUNDLE_PREFIXES.some((prefix) => {
    const lowered = prefix.toLowerCase();
    return id === lowered || id.startsWith(`${lowered}.`);
  });
};

/** How long "Always allow in this project" lasts. */
export const COMPUTER_USE_ALWAYS_ALLOW_DAYS = 30;

const AppArgument = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: 'The app\'s display name ("TextEdit") or bundle ID ("com.apple.TextEdit").',
});
const ElementRef = Schema.String.check(Schema.isPattern(/^e\d+$/)).annotate({
  description: 'An element ref ("e12") from the latest computer_snapshot of this app.',
});
const WindowArgument = Schema.String.check(Schema.isNonEmpty()).annotate({
  description: "A window ID from the snapshot's window list. Defaults to the focused window.",
});
const ReturnState = Schema.optionalKey(
  Schema.Boolean.annotate({
    description: "Include the app's new state after the action. Defaults to true.",
  }),
);
const PositiveCount = Schema.Int.check(Schema.isGreaterThan(0));

export const ComputerAppsInput = Schema.Struct({
  include_installed: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also list installed apps that are not running. Defaults to false.",
    }),
  ),
});
export type ComputerAppsInput = typeof ComputerAppsInput.Type;

export const ComputerSnapshotInput = Schema.Struct({
  app: AppArgument,
  window: Schema.optionalKey(WindowArgument),
  include_screenshot: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Attach a screenshot of the window when allowed. Defaults to true. The tree is usually enough.",
    }),
  ),
  max_nodes: Schema.optionalKey(PositiveCount),
  max_depth: Schema.optionalKey(PositiveCount),
});
export type ComputerSnapshotInput = typeof ComputerSnapshotInput.Type;

export const ComputerClickInput = Schema.Struct({
  app: AppArgument,
  ref: Schema.optionalKey(ElementRef),
  x: Schema.optionalKey(Schema.Number.annotate({ description: "Window-local x in points." })),
  y: Schema.optionalKey(Schema.Number.annotate({ description: "Window-local y in points." })),
  window: Schema.optionalKey(WindowArgument),
  button: Schema.optionalKey(Schema.Literals(["left", "right"])),
  count: Schema.optionalKey(Schema.Literals([1, 2])),
  return_state: ReturnState,
});
export type ComputerClickInput = typeof ComputerClickInput.Type;

export const ComputerTypeInput = Schema.Struct({
  app: AppArgument,
  text: Schema.String.check(Schema.isMaxLength(COMPUTER_USE_MAX_TYPE_CHARS)),
  ref: Schema.optionalKey(ElementRef),
  replace: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Replace the field's text. Defaults to false." }),
  ),
  return_state: ReturnState,
});
export type ComputerTypeInput = typeof ComputerTypeInput.Type;

export const ComputerPressInput = Schema.Struct({
  app: AppArgument,
  keys: Schema.String.check(Schema.isNonEmpty()).annotate({
    description:
      'Chords joined by "+", sequences separated by spaces, e.g. "cmd+a", "shift+tab", "down down return".',
  }),
  ref: Schema.optionalKey(ElementRef),
  return_state: ReturnState,
});
export type ComputerPressInput = typeof ComputerPressInput.Type;

export const ComputerScrollInput = Schema.Struct({
  app: AppArgument,
  ref: Schema.optionalKey(ElementRef),
  direction: Schema.Literals(["up", "down", "left", "right"]),
  amount: Schema.optionalKey(Schema.Literals(["line", "page"])),
  times: Schema.optionalKey(
    PositiveCount.check(Schema.isLessThanOrEqualTo(COMPUTER_USE_MAX_SCROLL_TIMES)),
  ),
  return_state: ReturnState,
});
export type ComputerScrollInput = typeof ComputerScrollInput.Type;

export const ComputerFillInput = Schema.Struct({
  app: AppArgument,
  ref: ElementRef,
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  return_state: ReturnState,
});
export type ComputerFillInput = typeof ComputerFillInput.Type;

export const ComputerSelectInput = Schema.Struct({
  app: AppArgument,
  ref: ElementRef,
  option: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  range: Schema.optionalKey(
    Schema.Struct({
      start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  return_state: ReturnState,
});
export type ComputerSelectInput = typeof ComputerSelectInput.Type;

export const ComputerInvokeMenuInput = Schema.Struct({
  app: AppArgument,
  path: Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(Schema.isMinLength(1)),
  return_state: ReturnState,
});
export type ComputerInvokeMenuInput = typeof ComputerInvokeMenuInput.Type;

/** `apps.resolve` result from the helper. */
export const ComputerUseResolvedApp = Schema.Struct({
  bundleId: Schema.optionalKey(Schema.String),
  name: Schema.String,
  pid: Schema.optionalKey(Schema.Int),
  running: Schema.Boolean,
  forbidden: Schema.optionalKey(ComputerUseForbiddenReason),
});
export type ComputerUseResolvedApp = typeof ComputerUseResolvedApp.Type;

/** One `apps.list` entry from the helper. */
export const ComputerUseHelperAppEntry = Schema.Struct({
  name: Schema.String,
  bundleId: Schema.optionalKey(Schema.String),
  running: Schema.Boolean,
  pid: Schema.optionalKey(Schema.Int),
  regular: Schema.optionalKey(Schema.Boolean),
  forbidden: Schema.optionalKey(ComputerUseForbiddenReason),
});
export type ComputerUseHelperAppEntry = typeof ComputerUseHelperAppEntry.Type;

export const ComputerUseHelperAppsList = Schema.Struct({
  apps: Schema.Array(ComputerUseHelperAppEntry),
});

export const ComputerUseAppApproval = Schema.Literals(["always", "thread", "turn", "none"]);
export type ComputerUseAppApproval = typeof ComputerUseAppApproval.Type;

export const ComputerAppsResult = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      bundleId: Schema.optionalKey(Schema.String),
      running: Schema.Boolean,
      pid: Schema.optionalKey(Schema.Int),
      approval: ComputerUseAppApproval,
      forbidden: Schema.optionalKey(ComputerUseForbiddenReason),
    }),
  ),
});
export type ComputerAppsResult = typeof ComputerAppsResult.Type;

export const ComputerUseAppIdentity = Schema.Struct({
  name: Schema.String,
  bundleId: Schema.String,
  pid: Schema.Int,
});
export type ComputerUseAppIdentity = typeof ComputerUseAppIdentity.Type;

export const ComputerUseScreenshot = Schema.Struct({
  mimeType: Schema.String,
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export type ComputerUseScreenshot = typeof ComputerUseScreenshot.Type;

export const ComputerUseScreenshotOmitted = Schema.Literals([
  "screen_recording_not_granted",
  "disabled_in_settings",
  "window_minimized",
  "capture_failed",
  "not_requested",
]);
export type ComputerUseScreenshotOmitted = typeof ComputerUseScreenshotOmitted.Type;

/** `computer_snapshot` result, and `state` of action results. */
export const ComputerSnapshotResult = Schema.Struct({
  app: ComputerUseAppIdentity,
  windows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      focused: Schema.Boolean,
      minimized: Schema.Boolean,
      private: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  window: Schema.String,
  snapshot: Schema.String,
  tree: Schema.String,
  truncated: Schema.optionalKey(Schema.Literals(["nodes", "depth", "deadline", "size"])),
  focusedRef: Schema.optionalKey(Schema.String),
  screenshot: Schema.NullOr(ComputerUseScreenshot),
  screenshotOmitted: Schema.optionalKey(ComputerUseScreenshotOmitted),
  launched: Schema.optionalKey(Schema.Boolean),
  focusChanged: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Says which tagged text came from the app and must be treated as data. */
  untrustedContent: Schema.optionalKey(Schema.String),
});
export type ComputerSnapshotResult = typeof ComputerSnapshotResult.Type;

export const ComputerActionResult = Schema.Struct({
  app: ComputerUseAppIdentity,
  verified: Schema.Boolean,
  effect: Schema.Record(Schema.String, Schema.Boolean),
  method: Schema.String,
  state: Schema.optionalKey(ComputerSnapshotResult),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;

// ---------------------------------------------------------------------------
// Per-app approval card. Recorded as a `computer_use_app_request` turn item,
// like a secret request.

export const ComputerUseAppRequestChoice = Schema.Literals([
  "allow_once",
  "allow_thread",
  "always",
  "deny",
]);
export type ComputerUseAppRequestChoice = typeof ComputerUseAppRequestChoice.Type;

/** `pending` until answered; `cancelled` when the turn ended or the call went away. */
export const ComputerUseAppRequestStatus = Schema.Literals([
  "pending",
  "allow_once",
  "allow_thread",
  "always",
  "deny",
  "cancelled",
]);
export type ComputerUseAppRequestStatus = typeof ComputerUseAppRequestStatus.Type;

export const ComputerUseAppRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  choice: ComputerUseAppRequestChoice,
});
export type ComputerUseAppRequestAnswerInput = typeof ComputerUseAppRequestAnswerInput.Type;

const COMPUTER_USE_APP_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the request.",
  not_found: "This request no longer exists.",
  already_answered: "This request was already answered.",
  agent_stopped: "The agent that asked has stopped.",
  always_not_offered: "This app can't be always allowed.",
  settings_failed: "Could not save the app to the always-allowed list.",
  record_failed: "Could not record your answer.",
} as const;

export const ComputerUseAppRequestFailureReason = Schema.Literals(
  Object.keys(COMPUTER_USE_APP_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof COMPUTER_USE_APP_REQUEST_FAILURE_MESSAGES
  >,
);
export type ComputerUseAppRequestFailureReason = typeof ComputerUseAppRequestFailureReason.Type;

export class ComputerUseAppRequestError extends Schema.TaggedError<ComputerUseAppRequestError>()(
  "ComputerUseAppRequestError",
  {
    reason: ComputerUseAppRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return COMPUTER_USE_APP_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
