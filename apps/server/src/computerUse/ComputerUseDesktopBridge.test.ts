import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as ComputerUseDesktopBridge from "./ComputerUseDesktopBridge.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

describe("ComputerUseDesktopBridge", () => {
  it.live("shows the desktop who is acting and stops them on the desktop's request", () =>
    Effect.gen(function* () {
      const statuses: Array<{ readonly acting: boolean; readonly appName?: string | undefined }> =
        [];
      let stops = 0;
      const activity = yield* PubSub.unbounded<ComputerUseService.ComputerUseActivity>();
      const desktopStops = yield* PubSub.unbounded<void>();
      const channel = Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({
        available: true,
        computerUseStatus: (status) => Effect.sync(() => void statuses.push(status)),
        computerUseStops: Stream.fromPubSub(desktopStops),
      });
      const service = Layer.mock(ComputerUseService.ComputerUseService)({
        activity: Stream.fromPubSub(activity),
        stopActing: Effect.sync(() => {
          stops += 1;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ComputerUseDesktopBridge.make;
          yield* Effect.sleep("20 millis");
          yield* PubSub.publish(activity, {
            acting: true,
            threadId: ThreadId.make("thread-1"),
            appName: "TextEdit",
          });
          yield* PubSub.publish(activity, { acting: false });
          yield* PubSub.publish(desktopStops, undefined);
          yield* Effect.sleep("20 millis");
        }),
      ).pipe(Effect.provide(Layer.merge(channel, service)));

      assert.deepStrictEqual(statuses, [{ acting: true, appName: "TextEdit" }, { acting: false }]);
      assert.strictEqual(stops, 1);
    }),
  );

  it.effect("does nothing without a desktop", () =>
    Effect.scoped(ComputerUseDesktopBridge.make).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({ available: false }),
          Layer.mock(ComputerUseService.ComputerUseService)({}),
        ),
      ),
    ),
  );
});
