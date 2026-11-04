// @effect-diagnostics nodeBuiltinImport:off - Exercises the real inherited descriptors in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { COMPUTER_USE_SETTINGS_URLS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseSettings from "./ComputerUseSettings.ts";
import * as DesktopComputerUseChannel from "./DesktopComputerUseChannel.ts";

const FIXTURE = NodeURL.fileURLToPath(
  new URL("./testing/DesktopComputerUseChannel.fixture.ts", import.meta.url),
);

describe("DesktopComputerUseChannel over the desktop fds", () => {
  it("configures the desktop, matches responses by id, and fails requests when the desktop goes away", async () => {
    const child = NodeChildProcess.spawn(process.execPath, [FIXTURE], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    // @effect-diagnostics-next-line globalTimers:off -- Bounds the subprocess on failure.
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const toDesktop = child.stdio[3] as NodeJS.WritableStream;
    const fromServer = child.stdio[4] as NodeJS.ReadableStream;
    const send = (event: Record<string, unknown>) => toDesktop.write(`${JSON.stringify(event)}\n`);

    const commands: Array<Record<string, unknown>> = [];
    const held = new Map<string, number>();
    let commandBuffer = "";
    fromServer.on("data", (chunk: Buffer) => {
      commandBuffer += chunk.toString();
      let end: number;
      while ((end = commandBuffer.indexOf("\n")) >= 0) {
        const command = JSON.parse(commandBuffer.slice(0, end)) as Record<string, unknown>;
        commandBuffer = commandBuffer.slice(end + 1);
        commands.push(command);
        if (command.type !== "request") continue;
        const id = command.id as number;
        switch (command.method) {
          case "apps.list":
            held.set("apps.list", id);
            break;
          case "permissions.status":
            send({ type: "status", state: "running" });
            send({
              type: "response",
              id,
              error: {
                code: "permission_required",
                message: "no",
                details: { missing: ["accessibility"] },
                retryable: false,
              },
            });
            send({ type: "response", id: held.get("apps.list"), result: { apps: [] } });
            break;
          case "hang":
            toDesktop.end();
            break;
        }
      }
    });

    const results = new Map<string, unknown>();
    let output = "";
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      let end: number;
      while ((end = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        if (line.startsWith("{")) {
          const { label, value } = JSON.parse(line) as { label: string; value: unknown };
          results.set(label, value);
        } else if (line === "done") {
          results.set("done", true);
        }
      }
    });

    try {
      const exit = await new Promise<{ code: number | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code }));
      });
      expect(errors).not.toContain("Error");
      expect(exit.code).toBe(0);
      expect(commands[0]).toEqual({ type: "configure", enabled: true });
      expect(results.get("apps")).toEqual({ ok: { apps: [] } });
      expect(results.get("permissions")).toEqual({
        error: { code: "permission_required", details: { missing: ["accessibility"] } },
      });
      expect(results.get("status")).toEqual({ state: "running" });

      expect(results.get("slow")).toMatchObject({ error: { code: "timeout" } });
      const slow = commands.find((command) => command.method === "slow")!;
      expect(commands).toContainEqual(
        expect.objectContaining({ method: "cancel", params: { requestId: slow.id } }),
      );

      const disconnected = {
        error: { code: "computer_use_unavailable", details: { reason: "desktop_disconnected" } },
      };
      expect(results.get("hang")).toEqual(disconnected);
      expect(results.get("after")).toEqual(disconnected);
      expect(results.get("statusAfter")).toEqual({
        state: "stopped",
        reason: "desktop_disconnected",
      });
      expect(results.get("done")).toBe(true);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const stream of child.stdio) stream?.destroy();
    }
  });
});

const layerWithoutDesktop = DesktopComputerUseChannel.layer.pipe(
  Layer.provide(ServerSettings.layerTest({ enableAgentComputerUse: true })),
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-cu-none-" })),
  Layer.provide(NodeServices.layer),
);

describe("DesktopComputerUseChannel without a desktop", () => {
  effectIt.effect("is unavailable and fails every request", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopComputerUseChannel.DesktopComputerUseChannel;
      expect(channel.available).toBe(false);
      const error = yield* channel.request("apps.list", {}).pipe(Effect.asVoid, Effect.flip);
      expect(error).toMatchObject({
        code: "computer_use_unavailable",
        details: { reason: "desktop_unavailable" },
      });
    }).pipe(Effect.provide(layerWithoutDesktop)),
  );
});

/** A desktop that answers `permissions.status` and records every request. */
const fakeChannel = (requests: Array<string>) =>
  Layer.succeed(
    DesktopComputerUseChannel.DesktopComputerUseChannel,
    DesktopComputerUseChannel.DesktopComputerUseChannel.of({
      available: true,
      request: (method) =>
        Effect.sync(() => {
          requests.push(method);
          return method === "permissions.status"
            ? {
                accessibility: "granted",
                screenRecording: "not_granted",
                stopMonitor: "unavailable",
              }
            : {};
        }),
      configure: () => Effect.void,
      notifications: Stream.empty,
      statusChanges: Stream.empty,
      status: Effect.succeed({ state: "running" }),
    }),
  );

describe("ComputerUseSettings", () => {
  effectIt.effect("does not touch the helper while computer use is off", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const status = yield* ComputerUseSettings.readStatus();
      expect(status).toEqual({
        enabled: false,
        available: true,
        helper: { state: "running" },
        settingsUrls: COMPUTER_USE_SETTINGS_URLS,
      });
      const refused = yield* Effect.flip(ComputerUseSettings.requestPermission("accessibility"));
      expect(refused).toMatchObject({ details: { reason: "disabled" } });
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(fakeChannel(requests), ServerSettings.layerTest())));
  });

  effectIt.effect("reads the helper's own grants while computer use is on", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const status = yield* ComputerUseSettings.readStatus();
      expect(status.permissions).toEqual({
        accessibility: "granted",
        screenRecording: "not_granted",
        stopMonitor: "unavailable",
      });
      yield* ComputerUseSettings.requestPermission("screen_recording");
      yield* ComputerUseSettings.restartHelper();
      expect(requests).toEqual([
        "permissions.status",
        "permissions.request",
        "helper.restart",
        "permissions.status",
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          fakeChannel(requests),
          ServerSettings.layerTest({ enableAgentComputerUse: true }),
        ),
      ),
    );
  });
});
