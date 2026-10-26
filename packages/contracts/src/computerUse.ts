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
  "window_not_found",
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
