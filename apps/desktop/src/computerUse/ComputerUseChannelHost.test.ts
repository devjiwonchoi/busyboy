// @effect-diagnostics nodeBuiltinImport:off - Launches a fake helper process on a Unix socket.
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  COMPUTER_USE_SETTINGS_URLS,
  type ComputerUseHelperStatus,
  type DesktopComputerUseEvent,
} from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import { ComputerUseRouter } from "./ComputerUseChannelHost.ts";
import type { HelperClient } from "./HelperClient.ts";
import { HelperSupervisor, type HelperExit, type SpawnHelper } from "./HelperSupervisor.ts";

const FAKE_HELPER = NodeURL.fileURLToPath(new URL("./testing/FakeHelper.ts", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A router over a real supervisor running FakeHelper.ts. */
const withHelperProcess = () => {
  const socketDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cu-host-"));
  const children: Array<NodeChildProcess.ChildProcess> = [];
  const spawn: SpawnHelper = (_executable, env) => {
    const child = NodeChildProcess.spawn(process.execPath, [FAKE_HELPER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    children.push(child);
    const exited = new Promise<HelperExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { pid: child.pid, kill: (signal) => void child.kill(signal), exited };
  };
  const events: Array<DesktopComputerUseEvent> = [];
  let router: ComputerUseRouter | null = null;
  const supervisor = new HelperSupervisor({
    installer: {
      executablePath: "/unused",
      ensureInstalled: async () => ({
        path: "/installed/BusyBoy Computer Use.app",
        version: "7",
        executableSha256: "x",
        copied: false,
      }),
      verifyInstalled: async () => {},
    },
    socketPath: NodePath.join(socketDir, "helper.sock"),
    clientVersion: "test",
    supported: true,
    env: { BUSYBOY_CU_SOCKET_DIR: socketDir },
    spawn,
    onStatus: (status) => events.push(router!.statusEvent(status)),
  });
  router = new ComputerUseRouter(supervisor, (event) => events.push(event));
  cleanups.push(async () => {
    await router!.shutdown();
    NodeFS.rmSync(socketDir, { recursive: true, force: true });
  });
  return { router, events, children };
};

const isAlive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("ComputerUseRouter with a helper process", () => {
  it("refuses requests while disabled without starting the helper", async () => {
    const { router, events, children } = withHelperProcess();
    await router.handle({ type: "request", id: 1, method: "permissions.status", params: {} });
    expect(events).toEqual([
      {
        type: "response",
        id: 1,
        error: expect.objectContaining({
          code: "computer_use_unavailable",
          details: { reason: "disabled" },
        }),
      },
    ]);
    expect(children).toHaveLength(0);
  });

  it("starts the helper on the first request and stops it when turned off", async () => {
    const { router, events, children } = withHelperProcess();
    await router.handle({ type: "configure", enabled: true });
    events.length = 0;

    await router.handle({ type: "request", id: 7, method: "permissions.status", params: {} });
    expect(children).toHaveLength(1);
    expect(events).toEqual([
      { type: "status", state: "starting" },
      { type: "status", state: "running" },
      {
        type: "response",
        id: 7,
        result: {
          accessibility: "not_granted",
          screenRecording: "granted",
          stopMonitor: "available",
        },
      },
    ]);

    await router.handle({ type: "request", id: 8, method: "helper.status", params: {} });
    expect(events.at(-1)).toEqual({
      type: "response",
      id: 8,
      result: {
        status: { state: "running" },
        installedPath: "/installed/BusyBoy Computer Use.app",
        installedVersion: "7",
        helperVersion: "0.0.0-fake",
      },
    });

    await router.handle({
      type: "request",
      id: 9,
      method: "session.begin",
      params: { threadId: "t", turnId: "u" },
    });
    expect(router.activeSessions).toEqual([{ threadId: "t", turnId: "u" }]);

    const started = performance.now();
    await router.handle({ type: "configure", enabled: false });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(isAlive(children[0]!.pid)).toBe(false);
    expect(router.activeSessions).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "status", state: "stopped" });
  });

  it("restarts the helper on request", async () => {
    const { router, events, children } = withHelperProcess();
    await router.handle({ type: "configure", enabled: true });
    await router.handle({ type: "request", id: 1, method: "apps.list", params: {} });
    await router.handle({ type: "request", id: 2, method: "helper.restart", params: {} });
    expect(children).toHaveLength(2);
    expect(isAlive(children[0]!.pid)).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "response",
      id: 2,
      result: { status: { state: "running" } },
    });
  });
});

/** An in-process stand-in for the helper connection. */
const fakeSupervisor = () => {
  const sent: Array<{ id: number; method: string; params: unknown }> = [];
  const resolvers = new Map<number, (value: unknown) => void>();
  let nextId = 100;
  const client = {
    closed: false,
    send: (method: string, params: unknown) => {
      const id = nextId++;
      sent.push({ id, method, params });
      const response = new Promise<unknown>((resolve) => {
        if (method === "app.state") resolvers.set(id, resolve);
        else resolve({});
      });
      return { id, response };
    },
    request: (method: string, params: unknown) => client.send(method, params).response,
  };
  let running = false;
  let stops = 0;
  const supervisor = {
    status: { state: "stopped" } as ComputerUseHelperStatus,
    install: null,
    hello: null,
    get connected() {
      return running ? (client as unknown as HelperClient) : null;
    },
    client: async () => {
      running = true;
      return client as unknown as HelperClient;
    },
    stop: async () => {
      running = false;
      stops += 1;
    },
    restart: async () => client as unknown as HelperClient,
  };
  return { supervisor, sent, resolvers, stops: () => stops };
};

class ManualTimers {
  private time = 0;
  private readonly queue: Array<{ at: number; callback: () => void; id: number }> = [];
  private nextId = 0;
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.nextId;
    this.queue.push({ at: this.time + ms, callback, id });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    const index = this.queue.findIndex((entry) => entry.id === handle);
    if (index >= 0) this.queue.splice(index, 1);
  };
  advance(ms: number) {
    this.time += ms;
    for (const entry of this.queue.filter((candidate) => candidate.at <= this.time)) {
      this.queue.splice(this.queue.indexOf(entry), 1);
      entry.callback();
    }
  }
}

describe("ComputerUseRouter routing", () => {
  it("translates cancel ids and ends open sessions when turned off", async () => {
    const fake = fakeSupervisor();
    const events: Array<DesktopComputerUseEvent> = [];
    const router = new ComputerUseRouter(fake.supervisor, (event) => events.push(event));
    await router.configure(true);
    await router.handle({
      type: "request",
      id: 1,
      method: "session.begin",
      params: { threadId: "t", turnId: "u" },
    });
    const pending = router.handle({ type: "request", id: 2, method: "app.state", params: {} });
    await Promise.resolve();
    const helperId = fake.sent.at(-1)!.id;

    await router.handle({ type: "request", id: 3, method: "cancel", params: { requestId: 2 } });
    expect(fake.sent.at(-1)).toMatchObject({ method: "cancel", params: { requestId: helperId } });

    fake.resolvers.get(helperId)!({ tree: "" });
    await pending;
    expect(events.find((event) => event.type === "response" && event.id === 2)).toEqual({
      type: "response",
      id: 2,
      result: { tree: "" },
    });

    await router.configure(false);
    expect(fake.sent.at(-1)).toEqual({
      id: expect.any(Number),
      method: "session.end",
      params: { threadId: "t", turnId: "u" },
    });
  });

  it("does not start the helper just to cancel or end a session", async () => {
    const fake = fakeSupervisor();
    const events: Array<DesktopComputerUseEvent> = [];
    const router = new ComputerUseRouter(fake.supervisor, (event) => events.push(event));
    await router.configure(true);
    await router.handle({ type: "request", id: 1, method: "cancel", params: {} });
    await router.handle({
      type: "request",
      id: 2,
      method: "session.end",
      params: { threadId: "t", turnId: "u" },
    });
    expect(fake.sent).toEqual([]);
    expect(events).toEqual([
      { type: "response", id: 1, result: {} },
      { type: "response", id: 2, result: {} },
    ]);
  });

  it("stops an idle helper after ten minutes without a session", async () => {
    const fake = fakeSupervisor();
    const timers = new ManualTimers();
    const router = new ComputerUseRouter(fake.supervisor, () => {}, { timers });
    await router.configure(true);
    const stopsAfterEnable = fake.stops();

    await router.handle({
      type: "request",
      id: 1,
      method: "session.begin",
      params: { threadId: "t", turnId: "u" },
    });
    timers.advance(11 * 60_000);
    expect(fake.stops()).toBe(stopsAfterEnable);

    await router.handle({
      type: "request",
      id: 2,
      method: "session.end",
      params: { threadId: "t", turnId: "u" },
    });
    timers.advance(9 * 60_000);
    expect(fake.stops()).toBe(stopsAfterEnable);
    timers.advance(60_000);
    expect(fake.stops()).toBe(stopsAfterEnable + 1);
  });

  it("links to the same System Settings panes as the desktop permission helper", () => {
    expect(COMPUTER_USE_SETTINGS_URLS).toEqual({
      accessibility: MAC_PERMISSION_SETTINGS_URLS.accessibility,
      screenRecording: MAC_PERMISSION_SETTINGS_URLS["screen-recording"],
      inputMonitoring: MAC_PERMISSION_SETTINGS_URLS["input-monitoring"],
    });
  });
});
