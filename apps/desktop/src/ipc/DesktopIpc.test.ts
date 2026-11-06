import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as DesktopIpc from "./DesktopIpc.ts";

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

const trustAll: DesktopIpc.DesktopIpcSenderPolicy = () => true;
const APP_URL = "busyboy://app/";
const appPolicy = DesktopIpc.appWindowSenderPolicy(APP_URL);

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain, trustAll);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("forwards the invoke sender to the method", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
        trustAll,
      );
      const sender = { sender: { id: 7 } };
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          yield* Effect.promise(async () => listener!(sender, undefined));
        }),
      );

      assert.strictEqual(received, sender);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain, trustAll);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("answers sync calls from browser guests with null", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
      let handled = 0;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          on: (_channel, registered) => {
            listener = registered;
          },
        }),
        appPolicy,
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleSync({
            channel: "desktop.test.secret",
            handler: () =>
              Effect.sync(() => {
                handled += 1;
                return "secret";
              }),
          });
          const guest: DesktopIpc.DesktopIpcSyncEvent = {
            returnValue: undefined,
            sender: { getType: () => "webview" },
            senderFrame: { url: APP_URL, parent: null },
          };
          listener!(guest);
          assert.isNull(guest.returnValue);
          assert.strictEqual(handled, 0);

          const app: DesktopIpc.DesktopIpcSyncEvent = {
            returnValue: undefined,
            sender: { getType: () => "window" },
            senderFrame: { url: APP_URL, parent: null },
          };
          listener!(app);
          assert.strictEqual(app.returnValue, "secret");
        }),
      );
    }),
  );

  describe("appWindowSenderPolicy", () => {
    const appFrame = { url: "busyboy://app/threads/1", parent: null };
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly event: Parameters<DesktopIpc.DesktopIpcSenderPolicy>[0];
      readonly trusted: boolean;
    }> = [
      {
        name: "the app window's top frame",
        event: { sender: { getType: () => "window" }, senderFrame: appFrame },
        trusted: true,
      },
      {
        name: "a preview guest, even at the app URL",
        event: { sender: { getType: () => "webview" }, senderFrame: appFrame },
        trusted: false,
      },
      {
        name: "an iframe inside the app window",
        event: {
          sender: { getType: () => "window" },
          senderFrame: { url: "busyboy://app/frame", parent: appFrame },
        },
        trusted: false,
      },
      {
        name: "a window showing a web page",
        event: {
          sender: { getType: () => "window" },
          senderFrame: { url: "https://evil.example/", parent: null },
        },
        trusted: false,
      },
      {
        name: "the development scheme in a production build",
        event: {
          sender: { getType: () => "window" },
          senderFrame: { url: "busyboy-dev://app/", parent: null },
        },
        trusted: false,
      },
      {
        name: "another host on the app scheme",
        event: {
          sender: { getType: () => "window" },
          senderFrame: { url: "busyboy://evil/", parent: null },
        },
        trusted: false,
      },
      {
        name: "a sender whose frame is gone",
        event: { sender: { getType: () => "window" }, senderFrame: null },
        trusted: false,
      },
      {
        name: "a sender without a type",
        event: { sender: {}, senderFrame: appFrame },
        trusted: false,
      },
    ];
    for (const { name, event, trusted } of cases) {
      it(`${trusted ? "accepts" : "refuses"} ${name}`, () => {
        assert.strictEqual(appPolicy(event), trusted);
      });
    }
  });

  it.effect("refuses invoke calls from untrusted senders before the handler runs", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      let handled = 0;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
        appPolicy,
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.bearerToken",
            handler: () =>
              Effect.sync(() => {
                handled += 1;
                return "token";
              }),
          });

          const guest = yield* Effect.promise(() =>
            Promise.resolve(
              listener!(
                {
                  sender: { id: 2, getType: () => "webview" },
                  senderFrame: { url: "https://evil.example/", parent: null },
                },
                undefined,
              ),
            ).then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
          assert.instanceOf(guest, DesktopIpc.DesktopIpcUntrustedSenderRejection);
          assert.strictEqual(handled, 0);

          const app = yield* Effect.promise(async () =>
            listener!(
              {
                sender: { id: 1, getType: () => "window" },
                senderFrame: { url: APP_URL, parent: null },
              },
              undefined,
            ),
          );
          assert.strictEqual(app, "token");
          assert.strictEqual(handled, 1);
        }),
      );
    }),
  );
});
