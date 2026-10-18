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

import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

const makeLayer = (events: string[]) => {
  const dependencies = Layer.mergeAll(
    NodePath.layerPosix,
    FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
    Layer.mock(DesktopEnvironment.DesktopEnvironment)({
      stateDir: "/tmp/busyboy",
      appDataDirectory: "/tmp/app-data",
      isDevelopment: true,
      platform: "linux",
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(ElectronApp.ElectronApp)({
      setPath: (key, value) =>
        Effect.sync(() => {
          events.push(`path:${key}:${value}`);
        }),
      quit: Effect.sync(() => {
        events.push("quit");
      }),
    }),
    Layer.mock(ElectronShell.ElectronShell)({}),
    Layer.mock(ElectronWindow.ElectronWindow)({}),
    Layer.mock(DesktopWebLinks.DesktopWebLinks)({}),
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
});
