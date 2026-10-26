import {
  CommandId,
  type ComputerUseActionResult,
  type ComputerUseApp,
  type ComputerUseAppState,
  type ComputerUseClickInput,
  type ComputerUseDragInput,
  ComputerUseError,
  type ComputerUseErrorCode,
  type ComputerUseGetAppStateInput,
  type ComputerUseInvokeMenuInput,
  type ComputerUsePressKeyInput,
  type ComputerUseScrollInput,
  type ComputerUseSetValueInput,
  type ComputerUseTypeTextInput,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { AppInfo, CuaDriverLike, WindowInfo } from "@trycua/cua-driver";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseApprovals from "./ComputerUseApprovals.ts";
import * as ComputerUseDriver from "./ComputerUseDriver.ts";
import { computerUseAppPolicy } from "./ComputerUsePolicy.ts";

/** The agent session calling a computer-use tool. */
export interface ComputerUseCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

/** Whether an agent is operating the computer, for the desktop's overlay. */
export type ComputerUseActivity =
  | { readonly acting: false }
  | { readonly acting: true; readonly threadId: ThreadId; readonly appName: string };

type WithCaller<T> = T & { readonly caller: ComputerUseCaller };
type Action<T> = (input: WithCaller<T>) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;

export class ComputerUseService extends Context.Service<
  ComputerUseService,
  {
    readonly listApps: (input: {
      readonly caller: ComputerUseCaller;
      readonly includeNotRunning: boolean;
    }) => Effect.Effect<{ readonly apps: ReadonlyArray<ComputerUseApp> }, ComputerUseError>;
    readonly getAppState: (
      input: WithCaller<ComputerUseGetAppStateInput>,
    ) => Effect.Effect<ComputerUseAppState, ComputerUseError>;
    readonly click: Action<ComputerUseClickInput>;
    readonly typeText: Action<ComputerUseTypeTextInput>;
    readonly pressKey: Action<ComputerUsePressKeyInput>;
    readonly scroll: Action<ComputerUseScrollInput>;
    readonly drag: Action<ComputerUseDragInput>;
    readonly setValue: Action<ComputerUseSetValueInput>;
    readonly invokeMenu: Action<ComputerUseInvokeMenuInput>;
    readonly activity: Stream.Stream<ComputerUseActivity>;
    /** Stops the agent that is operating the computer, as the user asked from the desktop. */
    readonly stopActing: Effect.Effect<void>;
  }
>()("t3/computerUse/ComputerUseService") {}

// Claude downsamples images whose long edge exceeds this, so a larger capture
// only costs tokens.
const MAX_SCREENSHOT_EDGE = 1568;
// Text is inserted in pieces so a stop lands between them, not after the whole text.
export const TYPE_TEXT_CHUNK = 200;
// Snapshots this server handed out, to check element tokens against.
const MAX_REMEMBERED_SNAPSHOTS = 500;
const MAX_RESULT_TEXT = 2_000;
// How often an action checks that its turn is still running.
const RUN_WATCH_INTERVAL = Duration.millis(250);
// Tools whose input schema takes delivery_mode; the driver rejects unknown
// arguments, and set_value and invoke_menu act through accessibility only.
const BACKGROUND_DELIVERY_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
]);

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

const screenLocked = () =>
  fail(
    "screen_locked",
    "The Mac is locked. Ask the user to unlock it, then try again. Busyboy never unlocks the Mac.",
  );

/** The window an agent most likely means: the frontmost ordinary window on screen. */
function defaultWindow(windows: ReadonlyArray<WindowInfo>): WindowInfo | undefined {
  const candidates = windows.filter(
    (window) => window.isOnScreen && (window.layer ?? 0) === 0 && window.minimized !== true,
  );
  return candidates.toSorted((a, b) => Number((b.zIndex ?? 0n) - (a.zIndex ?? 0n)))[0];
}

/**
 * Turns a driver refusal into a code the agent can act on. The driver's own
 * text goes along: it is local, names the reason, and often the next step.
 */
function actionRefused(text: string): ComputerUseError {
  const message = text.trim().slice(0, MAX_RESULT_TEXT) || "The driver refused the action.";
  if (/screen_locked/.test(text)) return screenLocked();
  if (/stale_element_token|unknown_snapshot|stale_target|target_changed/.test(text)) {
    return fail(
      "invalid_element",
      `That element is from an older read of the window. Call computer_get_app_state again and use its new elements. ${message}`,
    );
  }
  // The driver's codes for input it will not send without the app in front.
  if (
    /background_(unavailable|occluded)|window_not_key|no_focused_text_input|target_focus_unconfirmed/.test(
      text,
    )
  ) {
    return fail(
      "background_unsupported",
      `${message} This app does not take that input without coming to the front. Try an element action, or ask the user.`,
    );
  }
  return fail("action_failed", message);
}

interface Target {
  readonly app: AppInfo & { readonly bundleId: string };
  readonly window: WindowInfo;
  readonly windows: ReadonlyArray<WindowInfo>;
}

interface SnapshotOwner {
  readonly pid: number;
  readonly windowId: string;
}

export const make = Effect.gen(function* () {
  const driver = yield* ComputerUseDriver.ComputerUseDriver;
  const approvals = yield* ComputerUseApprovals.ComputerUseApprovals;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const desktop = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const snapshots = yield* Ref.make(new Map<string, SnapshotOwner>());
  // The one run that may operate the computer right now.
  const actingRun = yield* Ref.make(
    Option.none<{ readonly threadId: ThreadId; readonly runId: RunId }>(),
  );
  // Claims are checked and taken one at a time, so two first actions cannot both win.
  const claimLock = yield* Semaphore.make(1);
  const activity = yield* SubscriptionRef.make<ComputerUseActivity>({ acting: false });
  const watchers = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watchers, Exit.void));

  const activeRunOf = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, ["runs"], { messageRoles: [] }).pipe(
      Effect.map((records) => ThreadManagementService.latestActiveRun(records)),
      Effect.orElseSucceed(() => undefined),
    );

  /**
   * One run operates the computer at a time: two agents typing into the same
   * Mac would interleave their input, and one stop would end both. A run that
   * has ended no longer holds it.
   */
  const claimComputer = (caller: ComputerUseCaller) =>
    claimLock.withPermits(1)(claimComputerUnlocked(caller));

  const claimComputerUnlocked = Effect.fn("ComputerUseService.claimComputer")(function* (
    caller: ComputerUseCaller,
  ) {
    const run = yield* activeRunOf(caller.threadId);
    if (run === undefined) {
      return yield* fail("stopped", "Computer use acts only during an active turn of this agent.");
    }
    const holder = yield* Ref.get(actingRun);
    if (Option.isSome(holder) && holder.value.runId !== run.id) {
      const holderRun = yield* activeRunOf(holder.value.threadId);
      if (holderRun?.id === holder.value.runId) {
        return yield* fail(
          "computer_busy",
          "Another Busyboy thread is operating the computer right now. Wait for it to finish, or ask the user.",
        );
      }
    }
    const isNewClaim = Option.isNone(holder) || holder.value.runId !== run.id;
    yield* Ref.set(actingRun, Option.some({ threadId: caller.threadId, runId: run.id }));
    if (isNewClaim) {
      // The overlay stays up for the whole turn, not just each action, and
      // goes away once the turn ends.
      yield* runEnded(caller.threadId, run.id).pipe(
        Effect.andThen(releaseClaim(run.id)),
        Effect.forkIn(watchers),
      );
    }
    return run.id;
  });

  const releaseClaim = (runId: RunId) =>
    Ref.modify(actingRun, (holder) =>
      Option.isSome(holder) && holder.value.runId === runId
        ? [true, Option.none()]
        : [false, holder],
    ).pipe(
      Effect.flatMap((released) =>
        released ? SubscriptionRef.set(activity, { acting: false }) : Effect.void,
      ),
    );

  const stopActing = Effect.gen(function* () {
    const holder = yield* Ref.get(actingRun);
    if (Option.isNone(holder)) return;
    const { threadId, runId } = holder.value;
    yield* Effect.gen(function* () {
      const thread = yield* projections.getThread(threadId);
      yield* threadManagement.interruptThread({
        projectId: thread.projectId,
        commandId: CommandId.make(`computer-use-stop:${runId}`),
        threadId,
        runId,
        reason: "The user stopped computer use.",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not interrupt the turn using the computer", { cause }),
      ),
    );
    // Stop input already on its way even if the interrupt is slow to land.
    yield* driver.restart;
    yield* releaseClaim(runId);
  }).pipe(Effect.withSpan("ComputerUseService.stopActing"));

  /** Completes when the run is no longer active. */
  const runEnded = (threadId: ThreadId, runId: RunId) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(RUN_WATCH_INTERVAL);
        const run = yield* activeRunOf(threadId);
        if (run?.id !== runId) return;
      }
    });

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

  const withWorker = <A>(
    caller: ComputerUseCaller,
    use: (worker: CuaDriverLike) => Effect.Effect<A, ComputerUseError>,
  ) =>
    requireEnabled(caller.threadId).pipe(
      Effect.andThen(
        driver.withWorker(use).pipe(
          Effect.catchTags({
            ComputerUseUnavailableError: (error) =>
              Effect.fail(fail("computer_use_unavailable", error.message)),
            ComputerUseDriverStartError: (error) => Effect.fail(driverFailed(error.cause)),
          }),
        ),
      ),
    );

  /**
   * Finds the app and window a call means, refusing what computer use never
   * touches, and asks the user before the first use of the app in a run.
   */
  const resolveTarget = Effect.fn("ComputerUseService.resolveTarget")(function* (
    worker: CuaDriverLike,
    input: {
      readonly caller: ComputerUseCaller;
      readonly app: string;
      readonly windowId?: string | undefined;
    },
  ) {
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
    return {
      app: { ...app, bundleId: app.bundleId },
      window,
      windows,
      permissions,
    } satisfies Target & { readonly permissions: DriverPermissions };
  });

  const rememberSnapshot = (snapshotId: string, owner: SnapshotOwner) =>
    Ref.update(snapshots, (current) => {
      const next = new Map(current);
      next.set(snapshotId, owner);
      while (next.size > MAX_REMEMBERED_SNAPSHOTS) next.delete(next.keys().next().value!);
      return next;
    });

  /** An element token must come from a read of this very app and window. */
  const requireElement = (token: string, target: Target) =>
    Effect.gen(function* () {
      const snapshotId = token.slice(0, token.lastIndexOf(":"));
      const owner = (yield* Ref.get(snapshots)).get(snapshotId);
      if (
        owner === undefined ||
        owner.pid !== target.app.pid ||
        owner.windowId !== String(target.window.windowId)
      ) {
        return yield* fail(
          "invalid_element",
          `"${token}" is not an element of ${target.app.name}'s window. Use one from computer_get_app_state for this app and window.`,
        );
      }
    });

  const listApps: ComputerUseService["Service"]["listApps"] = Effect.fn(
    "ComputerUseService.listApps",
  )(function* ({ caller, includeNotRunning }) {
    return yield* withWorker(caller, (worker) =>
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
    return yield* withWorker(input.caller, (worker) =>
      Effect.gen(function* () {
        const { app, window, windows, permissions } = yield* resolveTarget(worker, input);
        const includeScreenshot = input.includeScreenshot === true;
        if (includeScreenshot && !permissions.screenRecording) {
          return yield* permissionRequired("Screen Recording");
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
          return yield* screenLocked();
        }
        if (state.snapshotId !== undefined) {
          yield* rememberSnapshot(state.snapshotId, {
            pid: app.pid,
            windowId: String(window.windowId),
          });
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

  /**
   * Runs one of the driver's actions on the resolved window. Input always goes
   * to that app in the background; the driver never brings it to the front.
   */
  const runAction = <
    I extends {
      readonly app: string;
      readonly windowId?: string | undefined;
      readonly element?: string | undefined;
      readonly foreground?: boolean | undefined;
    },
  >(
    name: string,
    input: WithCaller<I>,
    steps: (
      target: Target,
    ) => ReadonlyArray<{ readonly tool: string; readonly args: Record<string, unknown> }>,
  ) =>
    withWorker(input.caller, (worker) =>
      Effect.gen(function* () {
        const runId = yield* claimComputer(input.caller);
        const perform = Effect.gen(function* () {
          const target = yield* resolveTarget(worker, input);
          const foreground = input.foreground === true;
          if (foreground) {
            // Foreground input goes wherever the keyboard focus is; on a lock
            // screen that would be the password field.
            if (yield* desktop.screenLocked) return yield* screenLocked();
            yield* approvals.require({
              threadId: input.caller.threadId,
              providerInstanceId: input.caller.providerInstanceId,
              appName: target.app.name,
              bundleId: target.app.bundleId,
              kind: "foreground",
            });
          }
          yield* SubscriptionRef.set(activity, {
            acting: true,
            threadId: input.caller.threadId,
            appName: target.app.name,
          });
          if (input.element !== undefined) yield* requireElement(input.element, target);
          const results: Array<string> = [];
          for (const step of steps(target)) {
            const args = BACKGROUND_DELIVERY_TOOLS.has(step.tool)
              ? {
                  ...step.args,
                  // Foreground delivery needs the exact window to bring forward.
                  ...(foreground ? windowArgs(target) : {}),
                  delivery_mode: foreground ? "foreground" : "background",
                }
              : step.args;
            const result = yield* callDriver(() =>
              worker.callTool(step.tool, JSON.stringify(args)),
            );
            if (result.isError) return yield* actionRefused(result.text);
            results.push(result.text.trim());
          }
          return {
            app: target.app.name,
            windowId: String(target.window.windowId),
            result: results.join("\n").slice(0, MAX_RESULT_TEXT),
          } satisfies ComputerUseActionResult;
        }).pipe(
          // The driver cannot cancel an action it has started, so a stopped turn
          // or an aborted call restarts the worker to keep input from landing.
          Effect.onInterrupt(() => driver.restart),
        );
        const stoppedWhenRunEnds = runEnded(input.caller.threadId, runId).pipe(
          Effect.andThen(
            Effect.fail(fail("stopped", "The turn ended, so the action was stopped.")),
          ),
        );
        return yield* Effect.raceFirst(perform, stoppedWhenRunEnds);
      }).pipe(Effect.withSpan(`ComputerUseService.${name}`)),
    );

  const windowArgs = (target: Target) => ({
    pid: target.app.pid,
    window_id: Number(target.window.windowId),
  });

  /** An element token carries its window, so the driver takes it alone. */
  const elementOrWindow = (target: Target, element: string | undefined) =>
    element === undefined ? windowArgs(target) : { element_token: element };

  const requirePosition = (input: {
    readonly element?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
  }) =>
    input.element !== undefined || (input.x !== undefined && input.y !== undefined)
      ? Effect.void
      : Effect.fail(fail("action_failed", "Pass an element, or both x and y."));

  const click: ComputerUseService["Service"]["click"] = (input) =>
    requirePosition(input).pipe(
      Effect.andThen(
        runAction("click", input, (target) => [
          {
            tool: "click",
            args: {
              ...elementOrWindow(target, input.element),
              ...(input.element === undefined ? { x: input.x, y: input.y } : {}),
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.count === undefined ? {} : { count: input.count }),
            },
          },
        ]),
      ),
    );

  const typeText: ComputerUseService["Service"]["typeText"] = (input) =>
    runAction("typeText", input, (target) => {
      const chunks: Array<string> = [];
      for (let start = 0; start < input.text.length; start += TYPE_TEXT_CHUNK) {
        chunks.push(input.text.slice(start, start + TYPE_TEXT_CHUNK));
      }
      return chunks.map((text, index) => ({
        tool: "type_text",
        // Only the first piece targets the element; the rest continue at the caret.
        args: {
          ...(index === 0 ? elementOrWindow(target, input.element) : windowArgs(target)),
          text,
        },
      }));
    });

  const pressKey: ComputerUseService["Service"]["pressKey"] = (input) =>
    runAction("pressKey", input, (target) => [
      {
        tool: "press_key",
        args: {
          ...elementOrWindow(target, input.element),
          key: input.key,
          ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
        },
      },
    ]);

  const scroll: ComputerUseService["Service"]["scroll"] = (input) =>
    runAction("scroll", input, (target) => [
      {
        tool: "scroll",
        args: {
          ...(input.element === undefined ? windowArgs(target) : { element_token: input.element }),
          ...(input.element === undefined && input.x !== undefined && input.y !== undefined
            ? { x: input.x, y: input.y }
            : {}),
          direction: input.direction,
          ...(input.amount === undefined ? {} : { amount: input.amount }),
        },
      },
    ]);

  const drag: ComputerUseService["Service"]["drag"] = (input) =>
    runAction("drag", input, (target) => [
      {
        tool: "drag",
        args: {
          ...windowArgs(target),
          from_x: input.fromX,
          from_y: input.fromY,
          to_x: input.toX,
          to_y: input.toY,
        },
      },
    ]);

  const setValue: ComputerUseService["Service"]["setValue"] = (input) =>
    runAction("setValue", input, () => [
      { tool: "set_value", args: { element_token: input.element, value: input.value } },
    ]);

  const invokeMenu: ComputerUseService["Service"]["invokeMenu"] = (input) =>
    runAction("invokeMenu", input, (target) => [
      { tool: "invoke_menu", args: { ...windowArgs(target), path: input.path } },
    ]);

  return ComputerUseService.of({
    listApps,
    getAppState,
    click,
    typeText,
    pressKey,
    scroll,
    drag,
    setValue,
    invokeMenu,
    activity: SubscriptionRef.changes(activity),
    stopActing,
  });
});

export const layer = Layer.effect(ComputerUseService, make);
