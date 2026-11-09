import { expect, it } from "@effect/vitest";
import { RunId, ThreadId, type ComputerUseHelperStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseTurns from "./ComputerUseTurns.ts";
import * as DesktopComputerUseChannel from "./DesktopComputerUseChannel.ts";

const THREAD = ThreadId.make("thread-prewarm");
const RUN = RunId.make("run-prewarm");

const prewarmRequests = (input: {
  readonly enabled: boolean;
  readonly helper: ComputerUseHelperStatus;
  readonly runStatus: string | ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const channel = DesktopComputerUseChannel.DesktopComputerUseChannel.of({
      available: true,
      // Keep the helper stopped while requests are in flight.
      request: (method) =>
        Effect.sync(() => void requests.push(method)).pipe(Effect.andThen(Effect.never)),
      configure: () => Effect.void,
      notifications: Stream.empty,
      statusChanges: Stream.empty,
      status: Effect.succeed(input.helper),
    });
    const context = yield* Layer.build(
      ComputerUseTurns.layerWithoutEvents.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopComputerUseChannel.DesktopComputerUseChannel, channel),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            ServerSettings.layerTest({ enableAgentComputerUse: input.enabled }),
          ),
        ),
      ),
    );
    const turns = yield* ComputerUseTurns.ComputerUseTurns.pipe(Effect.provide(context));
    for (const status of typeof input.runStatus === "string"
      ? [input.runStatus]
      : input.runStatus) {
      yield* turns.handleDomainEvent({
        type: "run.updated",
        threadId: THREAD,
        payload: { id: RUN, status },
      } as never);
    }
    // The prewarm runs in the background.
    for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
    return requests;
  }).pipe(Effect.scoped);

it.effect("a run that starts while the helper is stopped prewarms it", () =>
  Effect.gen(function* () {
    expect(
      yield* prewarmRequests({
        enabled: true,
        helper: { state: "stopped" },
        runStatus: "starting",
      }),
    ).toEqual(["permissions.status"]);
    expect(
      yield* prewarmRequests({ enabled: true, helper: { state: "stopped" }, runStatus: "running" }),
    ).toEqual(["permissions.status"]);
  }),
);

it.effect("no prewarm while the helper runs, computer use is off, or the run ended", () =>
  Effect.gen(function* () {
    expect(
      yield* prewarmRequests({ enabled: true, helper: { state: "running" }, runStatus: "running" }),
    ).toEqual([]);
    expect(
      yield* prewarmRequests({
        enabled: true,
        helper: { state: "starting" },
        runStatus: "running",
      }),
    ).toEqual([]);
    expect(
      yield* prewarmRequests({
        enabled: false,
        helper: { state: "stopped" },
        runStatus: "running",
      }),
    ).toEqual([]);
    expect(
      yield* prewarmRequests({
        enabled: true,
        helper: { state: "stopped" },
        runStatus: "completed",
      }),
    ).toEqual([]);
  }),
);

it.effect("starting and running updates share an in-flight prewarm", () =>
  Effect.gen(function* () {
    expect(
      yield* prewarmRequests({
        enabled: true,
        helper: { state: "stopped" },
        runStatus: ["starting", "running"],
      }),
    ).toEqual(["permissions.status"]);
  }),
);

it.effect("unsupported desktops never prewarm", () =>
  Effect.gen(function* () {
    expect(
      yield* prewarmRequests({
        enabled: true,
        helper: { state: "stopped", reason: "unsupported_platform" },
        runStatus: ["starting", "running"],
      }),
    ).toEqual([]);
  }),
);
