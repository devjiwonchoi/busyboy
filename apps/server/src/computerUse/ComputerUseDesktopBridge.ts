/**
 * Connects computer use to the desktop app that started this backend: the
 * desktop shows its overlay and listens for Escape while an agent acts, and
 * its Stop or Escape stops that agent.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

export const make = Effect.gen(function* () {
  const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  if (!channel.available) return;
  const service = yield* ComputerUseService.ComputerUseService;
  yield* service.activity.pipe(
    Stream.runForEach((activity) =>
      channel.computerUseStatus(
        activity.acting ? { acting: true, appName: activity.appName } : { acting: false },
      ),
    ),
    Effect.forkScoped,
  );
  yield* channel.computerUseStops.pipe(
    Stream.runForEach(() => service.stopActing),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
