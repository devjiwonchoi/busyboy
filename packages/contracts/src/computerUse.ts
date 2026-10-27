import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Why a computer-use call failed. Each message tells the agent what to do
 * next, so it can be shown as is.
 */
export const ComputerUseErrorCode = Schema.Literals([
  // Not the macOS desktop app's own backend, or no driver installed.
  "computer_use_unavailable",
  // The user has not turned on computer use for this project.
  "computer_use_disabled",
  // Busyboy lacks a macOS permission the call needs.
  "permission_required",
  "app_not_found",
  "app_not_running",
  "app_forbidden",
  // The app reports no bundle ID, so it cannot be approved.
  "app_unidentified",
  // The user declined the approval card for this app.
  "app_denied",
  // No answer: the card timed out, the run ended, or the caller has no active run.
  "approval_unavailable",
  "window_not_found",
  // The element is not from the latest computer_get_app_state of this app.
  "invalid_element",
  // The app only takes this input in the foreground, which needs the user's go-ahead.
  "background_unsupported",
  // The driver refused or could not complete the action.
  "action_failed",
  // Another thread is operating the computer; one acts at a time.
  "computer_busy",
  // The agent's turn ended, so its action was stopped.
  "stopped",
  // Another thread is operating the computer; one acts at a time.
  "computer_busy",
  // The agent's turn ended, so its action was stopped.
  "stopped",
  "screen_locked",
  "driver_failed",
]);
export type ComputerUseErrorCode = typeof ComputerUseErrorCode.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  code: ComputerUseErrorCode,
  message: Schema.String,
}) {}

export const ComputerUseApp = Schema.Struct({
  name: Schema.String,
  bundleId: Schema.optional(Schema.String),
  running: Schema.Boolean,
  active: Schema.Boolean,
});
export type ComputerUseApp = typeof ComputerUseApp.Type;

export const ComputerUseListAppsInput = Schema.Struct({
  includeNotRunning: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also list installed apps that are not running. Defaults to false.",
    }),
  ),
});

export const ComputerUseListAppsResult = Schema.Struct({
  apps: Schema.Array(ComputerUseApp),
});

export const ComputerUseWindow = Schema.Struct({
  windowId: Schema.String,
  title: Schema.String,
});

export const ComputerUseGetAppStateInput = Schema.Struct({
  app: TrimmedNonEmptyString.annotate({
    description: "The app's name as computer_list_apps shows it, or its bundle ID.",
  }),
  windowId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A window from this app's `windows`. Defaults to the app's frontmost window on screen.",
    }),
  ),
  since: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The snapshotId of an earlier state of the same window. Returns only what changed since then.",
    }),
  ),
  includeScreenshot: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also return a screenshot of the window. Defaults to false; use it when the accessibility tree does not show enough.",
    }),
  ),
});
export type ComputerUseGetAppStateInput = typeof ComputerUseGetAppStateInput.Type;

export const ComputerUseScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});

export const ComputerUseAppState = Schema.Struct({
  app: Schema.String,
  bundleId: Schema.String,
  windowId: Schema.String,
  windowTitle: Schema.optional(Schema.String),
  windows: Schema.Array(ComputerUseWindow),
  snapshotId: Schema.optional(Schema.String),
  /**
   * `full` when `tree` is the whole accessibility tree, `diff` when it lists
   * only what changed since `since`, `unchanged` when nothing did.
   */
  treeKind: Schema.Literals(["full", "diff", "unchanged"]),
  tree: Schema.String,
  /** Set when the tree is incomplete, with the driver's explanation. */
  degradedReason: Schema.optional(Schema.String),
  truncationHint: Schema.optional(Schema.String),
  screenshot: Schema.optional(ComputerUseScreenshot),
});
export type ComputerUseAppState = typeof ComputerUseAppState.Type;

const ActionTarget = {
  app: TrimmedNonEmptyString.annotate({
    description: "The app's name as computer_list_apps shows it, or its bundle ID.",
  }),
  windowId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A window from computer_get_app_state's `windows`. Defaults to the frontmost one.",
    }),
  ),
};

const ElementToken = TrimmedNonEmptyString.annotate({
  description:
    "An element from the latest computer_get_app_state of this app: `<snapshotId>:<N>` for the row tagged [N].",
});

const Foreground = Schema.optional(
  Schema.Boolean.annotate({
    description:
      "Bring the app to the front for this input, then return to the user's app. Only after the background attempt failed with background_unsupported; the user is asked first.",
  }),
);

const Pixel = Schema.Number.annotate({
  description:
    "Pixels in the window's computer_get_app_state screenshot, from its top-left corner.",
});

export const ComputerUseClickInput = Schema.Struct({
  ...ActionTarget,
  foreground: Foreground,
  element: Schema.optional(ElementToken),
  x: Schema.optional(Pixel),
  y: Schema.optional(Pixel),
  button: Schema.optional(Schema.Literals(["left", "right"])),
  count: Schema.optional(
    Schema.Int.annotate({
      description: "2 for a double click, 3 for a triple click. Defaults to 1.",
    }),
  ),
});
export type ComputerUseClickInput = typeof ComputerUseClickInput.Type;

export const ComputerUseTypeTextInput = Schema.Struct({
  ...ActionTarget,
  foreground: Foreground,
  text: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Text to insert. It does not press keys: use computer_press_key for Return, Tab or arrows.",
  }),
  element: Schema.optional(ElementToken),
});
export type ComputerUseTypeTextInput = typeof ComputerUseTypeTextInput.Type;

export const ComputerUsePressKeyInput = Schema.Struct({
  ...ActionTarget,
  foreground: Foreground,
  key: TrimmedNonEmptyString.annotate({
    description:
      "return, tab, escape, up, down, left, right, space, delete, home, end, pageup, pagedown, f1-f12, or a letter or digit.",
  }),
  modifiers: Schema.optional(
    Schema.Array(Schema.Literals(["cmd", "shift", "option", "ctrl", "fn"])),
  ),
  element: Schema.optional(ElementToken),
});
export type ComputerUsePressKeyInput = typeof ComputerUsePressKeyInput.Type;

export const ComputerUseScrollInput = Schema.Struct({
  ...ActionTarget,
  foreground: Foreground,
  direction: Schema.Literals(["up", "down", "left", "right"]),
  amount: Schema.optional(
    Schema.Int.annotate({ description: "Wheel notches, 1-50. Defaults to 3." }),
  ),
  element: Schema.optional(ElementToken),
  x: Schema.optional(Pixel),
  y: Schema.optional(Pixel),
});
export type ComputerUseScrollInput = typeof ComputerUseScrollInput.Type;

export const ComputerUseDragInput = Schema.Struct({
  ...ActionTarget,
  foreground: Foreground,
  fromX: Pixel,
  fromY: Pixel,
  toX: Pixel,
  toY: Pixel,
});
export type ComputerUseDragInput = typeof ComputerUseDragInput.Type;

export const ComputerUseSetValueInput = Schema.Struct({
  ...ActionTarget,
  element: ElementToken,
  value: Schema.String.annotate({
    description: "The new value; for a pop-up menu, the title of the item to choose.",
  }),
});
export type ComputerUseSetValueInput = typeof ComputerUseSetValueInput.Type;

export const ComputerUseInvokeMenuInput = Schema.Struct({
  ...ActionTarget,
  path: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMinLength(2))
    .annotate({ description: 'Menu bar path, such as ["File", "Save"].' }),
});
export type ComputerUseInvokeMenuInput = typeof ComputerUseInvokeMenuInput.Type;

export const ComputerUseActionResult = Schema.Struct({
  app: Schema.String,
  windowId: Schema.String,
  /** The driver's account of what happened, such as whether a value read back changed. */
  result: Schema.String,
});
export type ComputerUseActionResult = typeof ComputerUseActionResult.Type;

export const ComputerUseGetPermissionsInput = Schema.Struct({
  /** Has macOS ask the user for the permissions that are missing. */
  request: Schema.Boolean,
});
export type ComputerUseGetPermissionsInput = typeof ComputerUseGetPermissionsInput.Type;

/** The macOS permissions of Busyboy Computer Use, the app that operates the computer. */
export const ComputerUsePermissions = Schema.Struct({
  /** False when this backend cannot run computer use, such as off macOS. */
  available: Schema.Boolean,
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;
