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
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
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
  /** Driver actions, with their parsed arguments. */
  readonly actions: Array<{ readonly tool: string; readonly args: Record<string, unknown> }>;
  /** When set, actions fail with this text, as a driver refusal does. */
  refusal: string | undefined;
  /** When set, actions never finish, like typing that is still going. */
  hang: boolean;
  /** Each thread's runs; a run counts as active while its status is "running". */
  readonly runs: Map<string, Array<{ id: string; status: string; ordinal: number }>>;
  restarts: number;
  readonly interrupts: Array<{ readonly threadId: string; readonly runId?: string }>;
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
    actions: [],
    refusal: undefined,
    hang: false,
    runs: new Map([[threadId, [{ id: "run-1", status: "running", ordinal: 1 }]]]),
    restarts: 0,
    interrupts: [],
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
    callTool: async (name: string, argumentsJson: string) => {
      if (name === "check_permissions") {
        return {
          text: "",
          images: [],
          isError: false,
          structuredJson: JSON.stringify(fake.permissions),
        };
      }
      fake.actions.push({ tool: name, args: JSON.parse(argumentsJson) });
      if (fake.hang) return new Promise(() => {});
      return fake.refusal === undefined
        ? { text: `${name} done`, images: [], isError: false }
        : { text: fake.refusal, images: [], isError: true };
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
    restart: Effect.sync(() => {
      fake.restarts += 1;
    }),
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
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          // Yields like a real database read, so concurrent callers interleave.
          getThreadRecords: (thread) =>
            Effect.yieldNow.pipe(
              Effect.andThen(Effect.sync(() => ({ runs: fake.runs.get(thread) ?? [] }) as never)),
            ),
          interruptThread: (input) =>
            Effect.sync(() => {
              fake.interrupts.push({
                threadId: input.threadId,
                ...(input.runId === undefined ? {} : { runId: input.runId }),
              });
              return { type: "no_active_run" } as never;
            }),
        }),
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

  describe("actions", () => {
    /** Reads TextEdit so its snapshot "snap-1" is known, as an agent would first. */
    const readFirst = (service: ComputerUseService.ComputerUseService["Service"]) =>
      service.getAppState({ caller, app: "TextEdit" });

    it.effect("clicks an element from the app's latest read, in the background", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        yield* readFirst(service);

        const result = yield* service.click({ caller, app: "TextEdit", element: "snap-1:4" });

        assert.deepStrictEqual(fake.actions, [
          { tool: "click", args: { element_token: "snap-1:4", delivery_mode: "background" } },
        ]);
        assert.deepStrictEqual(result, { app: "TextEdit", windowId: "2", result: "click done" });
      }),
    );

    it.effect("refuses an element that is not from this app's window", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        yield* readFirst(service);

        for (const element of ["other-snapshot:4", "snap-1"]) {
          assert.strictEqual(
            yield* errorCode(service.click({ caller, app: "TextEdit", element })),
            "invalid_element",
          );
        }
        assert.strictEqual(
          yield* errorCode(
            service.click({ caller, app: "TextEdit", windowId: "1", element: "snap-1:4" }),
          ),
          "invalid_element",
        );
        assert.lengthOf(fake.actions, 0);
      }),
    );

    it.effect("clicks a screenshot point in the chosen window, and needs a position", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });

        yield* service.click({ caller, app: "TextEdit", x: 10, y: 20, button: "right" });
        assert.deepStrictEqual(fake.actions[0], {
          tool: "click",
          args: {
            pid: 10,
            window_id: 2,
            x: 10,
            y: 20,
            button: "right",
            delivery_mode: "background",
          },
        });
        assert.strictEqual(
          yield* errorCode(service.click({ caller, app: "TextEdit", x: 10 })),
          "action_failed",
        );
      }),
    );

    it.effect("types long text in pieces, starting at the element", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        yield* readFirst(service);
        const text = "a".repeat(ComputerUseService.TYPE_TEXT_CHUNK * 2 + 5);

        yield* service.typeText({ caller, app: "TextEdit", element: "snap-1:2", text });

        assert.deepStrictEqual(
          fake.actions.map(({ args }) => [
            args.element_token ?? args.window_id,
            String(args.text).length,
          ]),
          [
            ["snap-1:2", ComputerUseService.TYPE_TEXT_CHUNK],
            [2, ComputerUseService.TYPE_TEXT_CHUNK],
            [2, 5],
          ],
        );
      }),
    );

    it.effect("sets values and chooses menu commands without a delivery mode", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        yield* readFirst(service);

        yield* service.setValue({
          caller,
          app: "TextEdit",
          element: "snap-1:7",
          value: "Helvetica",
        });
        yield* service.invokeMenu({ caller, app: "TextEdit", path: ["File", "Save"] });

        assert.deepStrictEqual(fake.actions, [
          { tool: "set_value", args: { element_token: "snap-1:7", value: "Helvetica" } },
          { tool: "invoke_menu", args: { pid: 10, window_id: 2, path: ["File", "Save"] } },
        ]);
      }),
    );

    it.effect("turns driver refusals into codes the agent can act on", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        const pressReturn = service.pressKey({ caller, app: "TextEdit", key: "return" });

        fake.refusal = "refused: screen_locked (the session is locked)";
        assert.strictEqual(yield* errorCode(pressReturn), "screen_locked");
        fake.refusal = "refused: background_unavailable for this surface";
        assert.strictEqual(yield* errorCode(pressReturn), "background_unsupported");
        fake.refusal = "refused: stale_element_token s1:4";
        assert.strictEqual(yield* errorCode(pressReturn), "invalid_element");
        fake.refusal = "the window closed";
        const other = yield* Effect.flip(pressReturn);
        assert.strictEqual(other.code, "action_failed");
        assert.include(other.message, "the window closed");
      }),
    );

    it.effect("never acts on an app the user declined", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        fake.denied.add("com.apple.TextEdit");
        const service = yield* makeService(fake, { enabled: true });
        assert.strictEqual(
          yield* errorCode(service.scroll({ caller, app: "TextEdit", direction: "down" })),
          "app_denied",
        );
        assert.lengthOf(fake.actions, 0);
      }),
    );

    it.effect("lets one thread operate the computer at a time", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const otherThread = ThreadId.make("thread-2");
        fake.runs.set(otherThread, [{ id: "run-9", status: "running", ordinal: 1 }]);
        const other = { ...caller, threadId: otherThread };
        const service = yield* makeService(fake, { enabled: true });

        yield* service.pressKey({ caller, app: "TextEdit", key: "tab" });
        assert.strictEqual(
          yield* errorCode(service.pressKey({ caller: other, app: "TextEdit", key: "tab" })),
          "computer_busy",
        );

        fake.runs.set(threadId, [{ id: "run-1", status: "completed", ordinal: 1 }]);
        yield* service.pressKey({ caller: other, app: "TextEdit", key: "tab" });
        assert.lengthOf(fake.actions, 2);
      }),
    );

    it.effect("does not let two threads claim the computer at the same moment", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const otherThread = ThreadId.make("thread-2");
        const earlierThread = ThreadId.make("thread-0");
        fake.runs.set(otherThread, [{ id: "run-9", status: "running", ordinal: 1 }]);
        fake.runs.set(earlierThread, [{ id: "run-0", status: "running", ordinal: 1 }]);
        const service = yield* makeService(fake, { enabled: true });
        // An earlier turn held the computer and has since ended, so both
        // newcomers find the claim free at the same time.
        yield* service.pressKey({
          caller: { ...caller, threadId: earlierThread },
          app: "TextEdit",
          key: "tab",
        });
        fake.runs.set(earlierThread, [{ id: "run-0", status: "completed", ordinal: 1 }]);

        const codes = yield* Effect.forEach(
          [caller, { ...caller, threadId: otherThread }],
          (who) =>
            service.pressKey({ caller: who, app: "TextEdit", key: "tab" }).pipe(
              Effect.as("ok"),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(codes.toSorted(), ["computer_busy", "ok"]);
      }),
    );

    it.live("stops an action and restarts the driver when the turn ends", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        fake.hang = true;
        const service = yield* makeService(fake, { enabled: true });

        const typing = yield* Effect.forkChild(
          errorCode(service.typeText({ caller, app: "TextEdit", text: "hello" })),
        );
        while (fake.actions.length === 0) yield* Effect.sleep("10 millis");
        fake.runs.set(threadId, [{ id: "run-1", status: "interrupted", ordinal: 1 }]);

        assert.strictEqual(yield* Fiber.join(typing), "stopped");
        assert.strictEqual(fake.restarts, 1);
      }),
    );

    it.live("restarts the driver when the call itself is aborted", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        fake.hang = true;
        const service = yield* makeService(fake, { enabled: true });

        const typing = yield* Effect.forkChild(
          service.typeText({ caller, app: "TextEdit", text: "hello" }),
        );
        while (fake.actions.length === 0) yield* Effect.sleep("10 millis");
        yield* Fiber.interrupt(typing);

        assert.strictEqual(fake.restarts, 1);
      }),
    );

    it.live("reports who is using the computer until their turn ends", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        const seen = yield* Effect.forkChild(
          service.activity.pipe(
            Stream.takeUntil((activity) => !activity.acting && fake.actions.length > 0),
            Stream.runCollect,
          ),
        );
        yield* Effect.sleep("20 millis");

        yield* service.pressKey({ caller, app: "TextEdit", key: "tab" });
        fake.runs.set(threadId, [{ id: "run-1", status: "completed", ordinal: 1 }]);

        assert.deepStrictEqual(yield* Fiber.join(seen), [
          { acting: false },
          { acting: true, threadId, appName: "TextEdit" },
          { acting: false },
        ]);
      }),
    );

    it.effect("stops the acting turn and its input when the user asks", () =>
      Effect.gen(function* () {
        const fake = fakeDriver();
        const service = yield* makeService(fake, { enabled: true });
        yield* service.stopActing;
        assert.lengthOf(fake.interrupts, 0);

        yield* service.pressKey({ caller, app: "TextEdit", key: "tab" });
        yield* service.stopActing;

        assert.deepStrictEqual(fake.interrupts, [{ threadId, runId: "run-1" }]);
        assert.strictEqual(fake.restarts, 1);
      }),
    );
  });
});
