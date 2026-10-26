import { assert, describe, it } from "@effect/vitest";
import { ComputerUseError, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  AppInfo,
  CuaDriverLike,
  GetWindowStateInput,
  WindowInfo,
  WindowStateOutput,
} from "@trycua/cua-driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseApprovals from "./ComputerUseApprovals.ts";
import * as ComputerUseDriver from "./ComputerUseDriver.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

const threadId = ThreadId.make("thread-1");
const caller = { threadId, providerInstanceId: ProviderInstanceId.make("claude") };
const projectId = ProjectId.make("project-1");

const textEdit: AppInfo = {
  pid: 10,
  name: "TextEdit",
  running: true,
  active: false,
  bundleId: "com.apple.TextEdit",
};

interface FakeDriver {
  apps: Array<AppInfo>;
  windows: Array<WindowInfo>;
  state: Partial<WindowStateOutput>;
  permissions: { accessibility: boolean; screen_recording: boolean };
  readonly stateRequests: Array<GetWindowStateInput>;
  /** Apps the user declines when asked. */
  readonly denied: Set<string>;
  readonly asked: Array<string>;
}

const window = (windowId: bigint, overrides: Partial<WindowInfo> = {}): WindowInfo => ({
  windowId,
  pid: textEdit.pid,
  appName: "TextEdit",
  title: `Window ${windowId}`,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  isOnScreen: true,
  layer: 0,
  zIndex: windowId,
  ...overrides,
});

function fakeDriver(): FakeDriver {
  return {
    apps: [textEdit],
    windows: [window(1n), window(2n)],
    state: { snapshotId: "snap-1", treeMarkdown: "- AXTextArea [e1] Hello" },
    permissions: { accessibility: true, screen_recording: true },
    stateRequests: [],
    denied: new Set(),
    asked: [],
  };
}

function workerFor(fake: FakeDriver): CuaDriverLike {
  return {
    listApps: async () => ({ apps: fake.apps }),
    listWindows: async () => ({ windows: fake.windows }),
    getWindowState: async (input: GetWindowStateInput) => {
      fake.stateRequests.push(input);
      return { pid: input.pid, windowId: input.windowId, images: [], ...fake.state };
    },
    callTool: async (name: string) => {
      assert.strictEqual(name, "check_permissions");
      return {
        text: "",
        images: [],
        isError: false,
        structuredJson: JSON.stringify(fake.permissions),
      };
    },
  } as unknown as CuaDriverLike;
}

function makeService(
  fake: FakeDriver,
  options?: {
    readonly enabled?: boolean;
    readonly available?: boolean;
    readonly threadFails?: boolean;
  },
) {
  const driver = ComputerUseDriver.ComputerUseDriver.of({
    available: options?.available ?? true,
    withWorker: (use) =>
      options?.available === false
        ? Effect.fail(new ComputerUseDriver.ComputerUseUnavailableError())
        : use(workerFor(fake)),
    restart: Effect.void,
    setKeepDisplayAwake: () => Effect.void,
  });
  return ComputerUseService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ComputerUseDriver.ComputerUseDriver, driver),
        Layer.succeed(
          ComputerUseApprovals.ComputerUseApprovals,
          ComputerUseApprovals.ComputerUseApprovals.of({
            require: (request) =>
              Effect.suspend(() => {
                fake.asked.push(request.bundleId);
                return fake.denied.has(request.bundleId)
                  ? Effect.fail(new ComputerUseError({ code: "app_denied", message: "declined" }))
                  : Effect.void;
              }),
            answer: () => Effect.void,
          }),
        ),
        ServerSettings.layerTest(
          options?.enabled === true
            ? { projectSettingsOverrides: { [projectId]: { enableAgentComputerUse: true } } }
            : {},
        ),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () =>
            options?.threadFails === true
              ? Effect.fail(new Error("database closed") as never)
              : Effect.succeed({ projectId } as never),
        }),
      ),
    ),
  );
}

const errorCode = <A>(effect: Effect.Effect<A, ComputerUseError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

describe("ComputerUseService", () => {
  it.effect("refuses every call until the user turns computer use on for the project", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      const service = yield* makeService(fake);
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "TextEdit" })),
        "computer_use_disabled",
      );
      assert.strictEqual(
        yield* errorCode(service.listApps({ caller, includeNotRunning: false })),
        "computer_use_disabled",
      );
      assert.lengthOf(fake.stateRequests, 0);
    }),
  );

  it.effect("treats a setting it cannot resolve as off", () =>
    Effect.gen(function* () {
      const service = yield* makeService(fakeDriver(), { enabled: true, threadFails: true });
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "TextEdit" })),
        "computer_use_disabled",
      );
    }),
  );

  it.effect("reports computer use as unavailable without the desktop's driver", () =>
    Effect.gen(function* () {
      const service = yield* makeService(fakeDriver(), { enabled: true, available: false });
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "TextEdit" })),
        "computer_use_unavailable",
      );
    }),
  );

  it.effect("reads the frontmost window's tree by app name, without a screenshot by default", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      const service = yield* makeService(fake, { enabled: true });

      const state = yield* service.getAppState({ caller, app: "textedit" });

      assert.deepStrictEqual(state, {
        app: "TextEdit",
        bundleId: "com.apple.TextEdit",
        windowId: "2",
        windowTitle: "Window 2",
        windows: [
          { windowId: "1", title: "Window 1" },
          { windowId: "2", title: "Window 2" },
        ],
        snapshotId: "snap-1",
        treeKind: "full",
        tree: "- AXTextArea [e1] Hello",
      });
      assert.strictEqual(fake.stateRequests[0]?.windowId, 2n);
      assert.strictEqual(fake.stateRequests[0]?.includeScreenshot, false);
    }),
  );

  it.effect("returns the screenshot when asked and the chosen window by ID", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.state = {
        ...fake.state,
        screenshotWidth: 800,
        screenshotHeight: 600,
        images: [{ mimeType: "image/png", dataBase64: "cG5n" }],
      };
      const service = yield* makeService(fake, { enabled: true });

      const state = yield* service.getAppState({
        caller,
        app: "com.apple.TextEdit",
        windowId: "1",
        includeScreenshot: true,
      });

      assert.strictEqual(state.windowId, "1");
      assert.deepStrictEqual(state.screenshot, {
        mimeType: "image/png",
        data: "cG5n",
        width: 800,
        height: 600,
      });
    }),
  );

  it.effect("returns only the changes when given an earlier snapshot", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.state = { snapshotId: "snap-2", sinceStatus: "diff", treeDiff: "+ AXButton [e9] Save" };
      const service = yield* makeService(fake, { enabled: true });

      const diff = yield* service.getAppState({ caller, app: "TextEdit", since: "snap-1" });
      assert.strictEqual(diff.treeKind, "diff");
      assert.strictEqual(diff.tree, "+ AXButton [e9] Save");
      assert.strictEqual(fake.stateRequests[0]?.since, "snap-1");

      fake.state = { snapshotId: "snap-3", sinceStatus: "no_change" };
      const unchanged = yield* service.getAppState({ caller, app: "TextEdit", since: "snap-2" });
      assert.strictEqual(unchanged.treeKind, "unchanged");
      assert.strictEqual(unchanged.tree, "");
    }),
  );

  it.effect("never reads forbidden or unidentified apps", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.apps = [
        { pid: 20, name: "Terminal", running: true, active: true, bundleId: "com.apple.Terminal" },
        { pid: 21, name: "Mystery", running: true, active: false },
      ];
      const service = yield* makeService(fake, { enabled: true });

      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "Terminal" })),
        "app_forbidden",
      );
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "Mystery" })),
        "app_unidentified",
      );
      assert.lengthOf(fake.stateRequests, 0);
    }),
  );

  it.effect("reads an app only after the user allows it", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.denied.add("com.apple.TextEdit");
      const service = yield* makeService(fake, { enabled: true });
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "TextEdit" })),
        "app_denied",
      );
      assert.deepStrictEqual(fake.asked, ["com.apple.TextEdit"]);
      assert.lengthOf(fake.stateRequests, 0);
    }),
  );

  it.effect("does not ask about apps it would refuse anyway", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.apps = [
        { pid: 20, name: "Terminal", running: true, active: true, bundleId: "com.apple.Terminal" },
      ];
      const service = yield* makeService(fake, { enabled: true });
      yield* errorCode(service.getAppState({ caller, app: "Terminal" }));
      assert.lengthOf(fake.asked, 0);
    }),
  );

  it.effect("asks for the missing macOS permission instead of reading", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.permissions = { accessibility: false, screen_recording: true };
      const service = yield* makeService(fake, { enabled: true });
      const error = yield* Effect.flip(service.getAppState({ caller, app: "TextEdit" }));
      assert.strictEqual(error.code, "permission_required");
      assert.include(error.message, "Accessibility");

      fake.permissions = { accessibility: true, screen_recording: false };
      const screenshot = yield* Effect.flip(
        service.getAppState({ caller, app: "TextEdit", includeScreenshot: true }),
      );
      assert.include(screenshot.message, "Screen Recording");
      assert.lengthOf(fake.stateRequests, 0);
    }),
  );

  it.effect("reports a locked Mac", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.state = { degraded: true, degradedReason: "screen_locked: the session is locked" };
      const service = yield* makeService(fake, { enabled: true });
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "TextEdit" })),
        "screen_locked",
      );
    }),
  );

  it.effect("explains unknown, closed, and windowless apps", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.apps = [
        textEdit,
        { ...textEdit, pid: 30, name: "Notes", bundleId: "com.apple.Notes", running: false },
      ];
      const service = yield* makeService(fake, { enabled: true });
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "Pages" })),
        "app_not_found",
      );
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "Notes" })),
        "app_not_running",
      );
      fake.windows = [window(5n, { isOnScreen: false })];
      assert.strictEqual(
        yield* errorCode(service.getAppState({ caller, app: "TextEdit" })),
        "window_not_found",
      );
    }),
  );

  it.effect("lists running apps unless asked for all", () =>
    Effect.gen(function* () {
      const fake = fakeDriver();
      fake.apps = [
        textEdit,
        { ...textEdit, pid: 30, name: "Notes", bundleId: "com.apple.Notes", running: false },
      ];
      const service = yield* makeService(fake, { enabled: true });
      const running = yield* service.listApps({ caller, includeNotRunning: false });
      assert.deepStrictEqual(
        running.apps.map((app) => app.name),
        ["TextEdit"],
      );
      const all = yield* service.listApps({ caller, includeNotRunning: true });
      assert.lengthOf(all.apps, 2);
    }),
  );
});
