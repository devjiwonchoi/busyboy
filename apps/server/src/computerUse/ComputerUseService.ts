import {
  type ComputerUseApp,
  type ComputerUseAppState,
  ComputerUseError,
  type ComputerUseErrorCode,
  type ComputerUseGetAppStateInput,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { CuaDriverLike, WindowInfo } from "@trycua/cua-driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseApprovals from "./ComputerUseApprovals.ts";
import * as ComputerUseDriver from "./ComputerUseDriver.ts";
import { computerUseAppPolicy } from "./ComputerUsePolicy.ts";

/** The agent session calling a computer-use tool. */
export interface ComputerUseCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export class ComputerUseService extends Context.Service<
  ComputerUseService,
  {
    readonly listApps: (input: {
      readonly caller: ComputerUseCaller;
      readonly includeNotRunning: boolean;
    }) => Effect.Effect<{ readonly apps: ReadonlyArray<ComputerUseApp> }, ComputerUseError>;
    readonly getAppState: (
      input: ComputerUseGetAppStateInput & { readonly caller: ComputerUseCaller },
    ) => Effect.Effect<ComputerUseAppState, ComputerUseError>;
  }
>()("t3/computerUse/ComputerUseService") {}

// Claude downsamples images whose long edge exceeds this, so a larger capture
// only costs tokens.
const MAX_SCREENSHOT_EDGE = 1568;

const fail = (code: ComputerUseErrorCode, message: string) =>
  new ComputerUseError({ code, message });

const driverFailed = (cause: unknown) => {
  const reason =
    typeof cause === "object" && cause !== null && "inner" in cause
      ? JSON.stringify((cause as { readonly inner: unknown }).inner)
      : cause instanceof Error
        ? cause.message
        : String(cause);
  return fail("driver_failed", `The computer-use driver failed: ${reason.slice(0, 300)}`);
};

const callDriver = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: driverFailed });

interface DriverPermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

const readPermissions = (worker: CuaDriverLike) =>
  callDriver(() => worker.callTool("check_permissions", "{}")).pipe(
    Effect.map((result): DriverPermissions => {
      const report = JSON.parse(result.structuredJson ?? "{}") as Record<string, unknown>;
      return {
        accessibility: report.accessibility === true,
        screenRecording: report.screen_recording === true,
      };
    }),
  );

const permissionRequired = (permission: "Accessibility" | "Screen Recording") =>
  fail(
    "permission_required",
    `Busyboy needs the macOS ${permission} permission for computer use. Ask the user to turn on Busyboy in System Settings > Privacy & Security > ${permission}, then try again.`,
  );

/** The window an agent most likely means: the frontmost ordinary window on screen. */
function defaultWindow(windows: ReadonlyArray<WindowInfo>): WindowInfo | undefined {
  const candidates = windows.filter(
    (window) => window.isOnScreen && (window.layer ?? 0) === 0 && window.minimized !== true,
  );
  return candidates.toSorted((a, b) => Number((b.zIndex ?? 0n) - (a.zIndex ?? 0n)))[0];
}

export const make = Effect.gen(function* () {
  const driver = yield* ComputerUseDriver.ComputerUseDriver;
  const approvals = yield* ComputerUseApprovals.ComputerUseApprovals;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  /**
   * Read on every call, so turning the setting off stops agents that are
   * already running. Anything that cannot be resolved counts as off.
   */
  const requireEnabled = Effect.fn("ComputerUseService.requireEnabled")(function* (
    threadId: ThreadId,
  ) {
    if (!driver.available) {
      return yield* fail(
        "computer_use_unavailable",
        "Computer use is only available in the Busyboy desktop app on macOS.",
      );
    }
    const enabled = Option.isNone(settings)
      ? false
      : yield* Effect.gen(function* () {
          const current = yield* settings.value.getSettings;
          const thread = yield* projections.getThread(threadId);
          return resolveProjectSettings(current, thread.projectId).settings.enableAgentComputerUse;
        }).pipe(Effect.orElseSucceed(() => false));
    if (!enabled) {
      return yield* fail(
        "computer_use_disabled",
        "Computer use is turned off for this project. Ask the user to turn it on in Busyboy's settings.",
      );
    }
  });

  const withWorker = <A>(use: (worker: CuaDriverLike) => Effect.Effect<A, ComputerUseError>) =>
    driver.withWorker(use).pipe(
      Effect.catchTags({
        ComputerUseUnavailableError: (error) =>
          Effect.fail(fail("computer_use_unavailable", error.message)),
        ComputerUseDriverStartError: (error) => Effect.fail(driverFailed(error.cause)),
      }),
    );

  const listApps: ComputerUseService["Service"]["listApps"] = Effect.fn(
    "ComputerUseService.listApps",
  )(function* ({ caller, includeNotRunning }) {
    yield* requireEnabled(caller.threadId);
    return yield* withWorker((worker) =>
      callDriver(() => worker.listApps({})).pipe(
        Effect.map(({ apps }) => ({
          apps: apps
            .filter((app) => includeNotRunning || app.running)
            .map((app) => ({
              name: app.name,
              ...(app.bundleId === undefined ? {} : { bundleId: app.bundleId }),
              running: app.running,
              active: app.active,
            })),
        })),
      ),
    );
  });

  const getAppState: ComputerUseService["Service"]["getAppState"] = Effect.fn(
    "ComputerUseService.getAppState",
  )(function* (input) {
    yield* requireEnabled(input.caller.threadId);
    return yield* withWorker((worker) =>
      Effect.gen(function* () {
        const { apps } = yield* callDriver(() => worker.listApps({}));
        const wanted = input.app.toLowerCase();
        const matches = apps.filter(
          (app) => app.bundleId?.toLowerCase() === wanted || app.name.toLowerCase() === wanted,
        );
        const app = matches.find((candidate) => candidate.running) ?? matches[0];
        if (app === undefined) {
          return yield* fail(
            "app_not_found",
            `No app named "${input.app}". Call computer_list_apps to see the apps and their bundle IDs.`,
          );
        }
        const policy = computerUseAppPolicy(app.bundleId);
        if (policy.kind === "forbidden") return yield* fail("app_forbidden", policy.reason);
        if (policy.kind === "unidentified" || app.bundleId === undefined) {
          return yield* fail(
            "app_unidentified",
            `${app.name} does not report a bundle ID, so computer use cannot be approved for it.`,
          );
        }
        if (!app.running) {
          return yield* fail(
            "app_not_running",
            `${app.name} is not running. Ask the user to open it, then try again.`,
          );
        }
        yield* approvals.require({
          threadId: input.caller.threadId,
          providerInstanceId: input.caller.providerInstanceId,
          appName: app.name,
          bundleId: app.bundleId,
        });

        const permissions = yield* readPermissions(worker);
        if (!permissions.accessibility) return yield* permissionRequired("Accessibility");
        const includeScreenshot = input.includeScreenshot === true;
        if (includeScreenshot && !permissions.screenRecording) {
          return yield* permissionRequired("Screen Recording");
        }

        const { windows } = yield* callDriver(() => worker.listWindows({ pid: app.pid }));
        const window =
          input.windowId === undefined
            ? defaultWindow(windows)
            : windows.find((candidate) => String(candidate.windowId) === input.windowId);
        if (window === undefined) {
          return yield* fail(
            "window_not_found",
            input.windowId === undefined
              ? `${app.name} has no window on screen.`
              : `${app.name} has no window ${input.windowId}. Use one from this app's \`windows\`.`,
          );
        }

        const state = yield* callDriver(() =>
          worker.getWindowState({
            pid: app.pid,
            windowId: window.windowId,
            includeScreenshot,
            maxImageDimension: MAX_SCREENSHOT_EDGE,
            ...(input.since === undefined ? {} : { since: input.since }),
          }),
        );
        if (state.degradedReason?.startsWith("screen_locked") === true) {
          return yield* fail(
            "screen_locked",
            "The Mac is locked. Ask the user to unlock it, then try again. Busyboy never unlocks the Mac.",
          );
        }

        const treeKind =
          input.since !== undefined && state.sinceStatus === "diff"
            ? ("diff" as const)
            : input.since !== undefined && state.sinceStatus === "no_change"
              ? ("unchanged" as const)
              : ("full" as const);
        const image = state.images[0];
        return {
          app: app.name,
          bundleId: app.bundleId,
          windowId: String(window.windowId),
          ...(state.windowTitle || window.title
            ? { windowTitle: state.windowTitle || window.title }
            : {}),
          windows: windows
            .filter((candidate) => (candidate.layer ?? 0) === 0)
            .map((candidate) => ({ windowId: String(candidate.windowId), title: candidate.title })),
          ...(state.snapshotId === undefined ? {} : { snapshotId: state.snapshotId }),
          treeKind,
          tree:
            treeKind === "diff"
              ? (state.treeDiff ?? "")
              : treeKind === "unchanged"
                ? ""
                : (state.treeMarkdown ?? ""),
          ...(state.degraded === true && state.degradedReason !== undefined
            ? { degradedReason: state.degradedReason }
            : {}),
          ...(state.truncationHint === undefined ? {} : { truncationHint: state.truncationHint }),
          ...(includeScreenshot && image !== undefined
            ? {
                screenshot: {
                  mimeType: "image/png" as const,
                  data: image.dataBase64,
                  width: state.screenshotWidth ?? 0,
                  height: state.screenshotHeight ?? 0,
                },
              }
            : {}),
        } satisfies ComputerUseAppState;
      }),
    );
  });

  return ComputerUseService.of({ listApps, getAppState });
});

export const layer = Layer.effect(ComputerUseService, make);
