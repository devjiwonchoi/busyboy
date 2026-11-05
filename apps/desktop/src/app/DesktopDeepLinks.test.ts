import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { requestLock, releaseLock } = vi.hoisted(() => ({
  requestLock: vi.fn(() => true),
  releaseLock: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { requestSingleInstanceLock: requestLock, releaseSingleInstanceLock: releaseLock },
}));

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

type Listener = (...args: ReadonlyArray<unknown>) => void;

const makeLayer = (
  events: string[],
  listeners = new Map<string, Listener>(),
  received: string[] = [],
  target: { readonly platform: NodeJS.Platform; readonly isPackaged: boolean } = {
    platform: "linux",
    isPackaged: false,
  },
) => {
  const dependencies = Layer.mergeAll(
    NodePath.layerPosix,
    FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
    Layer.mock(DesktopEnvironment.DesktopEnvironment)({
      stateDir: "/tmp/busyboy",
      appDataDirectory: "/tmp/app-data",
      isDevelopment: !target.isPackaged,
      ...target,
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(ElectronApp.ElectronApp)({
      setPath: (key, value) =>
        Effect.sync(() => {
          events.push(`path:${key}:${value}`);
        }),
      quit: Effect.sync(() => {
        events.push("quit");
      }),
      on: (eventName, listener) =>
        Effect.sync(() => {
          listeners.set(eventName, listener as Listener);
        }),
      setAsDefaultProtocolClient: (protocol) =>
        Effect.sync(() => {
          events.push(`protocol:${protocol}`);
          return true;
        }),
    }),
    Layer.mock(ElectronShell.ElectronShell)({}),
    Layer.mock(ElectronWindow.ElectronWindow)({}),
    Layer.mock(DesktopWebLinks.DesktopWebLinks)({
      receive: (url) =>
        Effect.sync(() => {
          received.push(url);
        }),
    }),
  );
  return DesktopDeepLinks.layer.pipe(Layer.provideMerge(dependencies));
};

describe("DesktopDeepLinks", () => {
  beforeEach(() => {
    requestLock.mockReset().mockReturnValue(true);
    releaseLock.mockReset();
  });

  it.effect(
    "sets the user-data path before acquiring the native lock and releases it on shutdown",
    () => {
      const events: string[] = [];
      requestLock.mockImplementation(() => {
        events.push("lock");
        return true;
      });
      return Effect.gen(function* () {
        yield* Effect.scoped(Layer.build(makeLayer(events)));
        assert.equal(events[0]?.startsWith("path:userData:"), true);
        assert.equal(events[1], "lock");
        assert.equal(requestLock.mock.calls.length, 1);
        assert.equal(releaseLock.mock.calls.length, 1);
      });
    },
  );

  it.effect(
    "quits a secondary instance without installing duplicate callbacks or releasing another instance's lock",
    () => {
      const events: string[] = [];
      requestLock.mockReturnValue(false);
      return Effect.gen(function* () {
        yield* DesktopDeepLinks.DesktopDeepLinks.pipe(
          Effect.flatMap((links) => links.configure),
          Effect.exit,
          Effect.provide(makeLayer(events)),
          Effect.scoped,
        );
        assert.equal(events.at(-1), "quit");
        assert.equal(releaseLock.mock.calls.length, 0);
      });
    },
  );

  it.effect("opens a link from a second launch that arrives before configure", () => {
    const listeners = new Map<string, Listener>();
    const received: string[] = [];
    const link = "busyboy://new?prompt=hi";
    return Effect.gen(function* () {
      const links = yield* DesktopDeepLinks.DesktopDeepLinks;
      listeners.get("second-instance")?.({}, ["BusyBoy.exe", link]);
      assert.deepEqual(received, []);
      yield* links.configure.pipe(Effect.provideService(HostProcess.Arguments, []));
      yield* Effect.yieldNow;
      assert.deepEqual(received, [link]);
    }).pipe(Effect.provide(makeLayer([], listeners, received)), Effect.scoped);
  });

  it.effect("registers busyboy:// for a packaged Windows app, which the installer does not", () => {
    const events: string[] = [];
    const configure = (platform: NodeJS.Platform) =>
      DesktopDeepLinks.DesktopDeepLinks.pipe(
        Effect.flatMap((links) => links.configure),
        Effect.provideService(HostProcess.Arguments, []),
        Effect.provide(makeLayer(events, new Map(), [], { platform, isPackaged: true })),
        Effect.scoped,
      );
    return Effect.gen(function* () {
      yield* configure("win32");
      assert.include(events, "protocol:busyboy");
      events.length = 0;
      // macOS registers through Info.plist.
      yield* configure("darwin");
      assert.notInclude(events, "protocol:busyboy");
    });
  });
});
