// @effect-diagnostics nodeBuiltinImport:off - Entry point for the computer-use channel test over inherited fds.
/**
 * Reads desktop events on fd 3, writes commands to fd 4, and prints one JSON
 * line per result so the parent test can check them.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DesktopComputerUseChannel from "../DesktopComputerUseChannel.ts";

Effect.gen(function* () {
  const base = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cu-channel-" })),
  );
  const context = yield* Layer.build(
    DesktopComputerUseChannel.layer.pipe(
      Layer.provide(ServerSettings.layerTest({ enableAgentComputerUse: true })),
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, {
          ...base,
          desktopComputerUseFd: 3,
          desktopComputerUseControlFd: 4,
        }),
      ),
    ),
  );
  const channel = Context.get(context, DesktopComputerUseChannel.DesktopComputerUseChannel);
  const outcome = (
    effect: Effect.Effect<unknown, { readonly code: string; readonly details?: unknown }>,
  ) =>
    effect.pipe(
      Effect.map((ok) => ({ ok })),
      Effect.catch((error) =>
        Effect.succeed({ error: { code: error.code, details: error.details } }),
      ),
    );
  const print = (label: string, value: unknown) => Console.log(JSON.stringify({ label, value }));

  // Answered in reverse order by the parent.
  const [apps, permissions] = yield* Effect.all(
    [outcome(channel.request("apps.list", {})), outcome(channel.request("permissions.status", {}))],
    { concurrency: 2 },
  );
  yield* print("apps", apps);
  yield* print("permissions", permissions);
  yield* print("status", yield* channel.status);

  yield* print("slow", yield* outcome(channel.request("slow", {}, { timeoutMs: 200 })));
  // The parent closes the desktop end instead of answering.
  yield* print("hang", yield* outcome(channel.request("hang", {})));
  yield* print("after", yield* outcome(channel.request("after", {})));
  yield* print("statusAfter", yield* channel.status);
  yield* Console.log("done");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
