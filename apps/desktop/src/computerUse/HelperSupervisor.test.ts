// @effect-diagnostics nodeBuiltinImport:off - Launches a fake helper process on a Unix socket.
// @effect-diagnostics globalTimers:off - Drives a fake clock and flushes Node's event loop.
// @effect-diagnostics globalDate:off - Bounds polls for process exits in the process tests.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { ComputerUseHelperStatus } from "@t3tools/contracts";

import { encodeHelperFrame, HelperFrameDecoder } from "./HelperFraming.ts";
import {
  HelperSupervisor,
  helperSpawnEnv,
  resolveHelperSocketPath,
  type HelperChild,
  type HelperExit,
  type HelperSupervisorOptions,
  type SpawnHelper,
  type SupervisorTimers,
} from "./HelperSupervisor.ts";

const FAKE_HELPER = NodeURL.fileURLToPath(new URL("./testing/FakeHelper.ts", import.meta.url));
const dirs: Array<string> = [];
const supervisors: Array<HelperSupervisor> = [];
const servers: Array<NodeNet.Server> = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cu-sup-"));
  dirs.push(dir);
  return dir;
};

const installer = () => {
  const calls = { ensure: 0, verify: 0 };
  return {
    calls,
    installer: {
      executablePath: "/unused/busyboy-computer-use",
      ensureInstalled: async () => {
        calls.ensure += 1;
        return { path: "/unused", version: "1", executableSha256: "x", copied: false };
      },
      verifyInstalled: async () => {
        calls.verify += 1;
      },
    },
  };
};

/**
 * Runs FakeHelper.ts with `extraEnv` (or the n-th entry of a list, one per
 * spawn); records every child so tests can check it is gone.
 */
const processSpawner = (
  extraEnv: Record<string, string> | ReadonlyArray<Record<string, string>> = {},
) => {
  const children: Array<NodeChildProcess.ChildProcess> = [];
  const spawn: SpawnHelper = (_executable, env) => {
    const extra = Array.isArray(extraEnv)
      ? (extraEnv[Math.min(children.length, extraEnv.length - 1)] ?? {})
      : (extraEnv as Record<string, string>);
    const child = NodeChildProcess.spawn(process.execPath, [FAKE_HELPER], {
      env: { ...process.env, ...env, ...extra },
      stdio: ["ignore", "ignore", "inherit"],
    });
    children.push(child);
    const exited = new Promise<HelperExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { pid: child.pid, kill: (signal) => void child.kill(signal), exited };
  };
  return { spawn, children };
};

const isAlive = (pid: number | undefined | null) => {
  if (pid === undefined || pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A FakeHelper the test starts itself, as if another launcher had. */
const startOutsideHelper = async (socketDir: string, extraEnv: Record<string, string> = {}) => {
  const child = NodeChildProcess.spawn(process.execPath, [FAKE_HELPER], {
    env: { ...process.env, BUSYBOY_CU_SOCKET_DIR: socketDir, ...extraEnv },
    stdio: ["ignore", "ignore", "inherit"],
  });
  outside.push(child);
  const socketPath = NodePath.join(socketDir, "helper.sock");
  for (let tries = 0; !NodeFS.existsSync(socketPath); tries += 1) {
    if (tries > 200) throw new Error("the outside helper did not open its socket");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return child;
};
const outside: Array<NodeChildProcess.ChildProcess> = [];
afterEach(() => {
  for (const child of outside.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

/** Polls until `check` holds; for process exits the test cannot await directly. */
const eventually = async (check: () => boolean, timeoutMs = 3_000) => {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const make = (options: Partial<HelperSupervisorOptions> & { readonly socketDir: string }) => {
  const statuses: Array<ComputerUseHelperStatus> = [];
  const supervisor = new HelperSupervisor({
    installer: installer().installer,
    socketPath: NodePath.join(options.socketDir, "helper.sock"),
    clientVersion: "test",
    supported: true,
    env: { BUSYBOY_CU_SOCKET_DIR: options.socketDir },
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  supervisors.push(supervisor);
  return { supervisor, statuses };
};

describe("HelperSupervisor with a helper process", () => {
  it("starts only when first needed and stops the process within two seconds", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner();
    const { supervisor, statuses } = make({ socketDir, spawn });

    expect(children).toHaveLength(0);
    expect(supervisor.status).toEqual({ state: "stopped" });

    const client = await supervisor.client();
    expect(children).toHaveLength(1);
    expect(await client.request("permissions.status", {})).toMatchObject({
      accessibility: "not_granted",
    });
    expect(await supervisor.client()).toBe(client);
    expect(children).toHaveLength(1);
    expect(statuses.map((status) => status.state)).toEqual(["starting", "running"]);

    const pid = children[0]!.pid;
    await supervisor.stop();
    expect(isAlive(pid)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(socketDir, "helper.sock"))).toBe(false);
    expect(supervisor.status).toEqual({ state: "stopped" });
  });

  it("kills a helper that ignores SIGTERM", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner({ FAKE_HELPER_IGNORE_SIGTERM: "1" });
    const { supervisor } = make({ socketDir, spawn });
    await supervisor.client();
    await supervisor.stop();
    expect(isAlive(children[0]!.pid)).toBe(false);
  });

  it("leaves no process behind when the helper runs as two stages", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner({ FAKE_HELPER_TWO_STAGE: "1" });
    const { supervisor } = make({ socketDir, spawn });
    await supervisor.client();
    const stage1 = children[0]!.pid;
    const stage2 = supervisor.hello?.pid;
    expect(stage2).toBeTypeOf("number");
    expect(stage2).not.toBe(stage1);

    await supervisor.stop();
    expect(isAlive(stage1)).toBe(false);
    expect(isAlive(stage2)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(socketDir, "helper.sock"))).toBe(false);
  });

  it("stops the serving stage even when stage 1 ignores SIGTERM and is killed", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner({
      FAKE_HELPER_TWO_STAGE: "1",
      FAKE_HELPER_STAGE1_IGNORE_SIGTERM: "1",
    });
    const { supervisor } = make({ socketDir, spawn });
    await supervisor.client();
    const stage2 = supervisor.hello?.pid;
    await supervisor.stop();
    expect(isAlive(children[0]!.pid)).toBe(false);
    // stop() returned once the socket was gone; the process exits right after.
    await eventually(() => !isAlive(stage2));
  });

  it("stops the helper it reached after exit 66 by its hello pid", async () => {
    const socketDir = tempDir();
    const existing = await startOutsideHelper(socketDir);
    const { spawn } = processSpawner({ FAKE_HELPER_EXIT: "66" });
    const { supervisor } = make({ socketDir, spawn });
    await supervisor.client();
    expect(supervisor.hello?.pid).toBe(existing.pid);

    await supervisor.stop();
    await eventually(() => !isAlive(existing.pid));
    expect(NodeFS.existsSync(NodePath.join(socketDir, "helper.sock"))).toBe(false);
  });

  it("reports a foreign helper that refuses us without counting crashes, and Restart stops it", async () => {
    const socketDir = tempDir();
    const foreign = await startOutsideHelper(socketDir, { FAKE_HELPER_REJECT: "1" });
    // The first launch finds the foreign helper; the one after Restart serves.
    const { spawn, children } = processSpawner([{ FAKE_HELPER_EXIT: "66" }, {}]);
    const { supervisor } = make({
      socketDir,
      spawn,
      findSocketOwner: async () => foreign.pid ?? null,
    });

    const failure = {
      error: { details: { reason: "helper_foreign_instance" }, retryable: false },
    };
    await expect(supervisor.client()).rejects.toMatchObject(failure);
    expect(supervisor.status).toMatchObject({ state: "error", reason: "helper_foreign_instance" });
    // Terminal, so no restart is scheduled and nothing respawns.
    await expect(supervisor.client()).rejects.toMatchObject(failure);
    expect(children).toHaveLength(1);

    const client = await supervisor.restart();
    expect(isAlive(foreign.pid)).toBe(false);
    expect(children).toHaveLength(2);
    expect(await client.request("apps.list", {})).toMatchObject({ method: "apps.list" });
  });

  it("connects to the helper that is already running after exit 66", async () => {
    const socketDir = tempDir();
    const socketPath = NodePath.join(socketDir, "helper.sock");
    const seen: Array<string> = [];
    const server = NodeNet.createServer((socket) => {
      const decoder = new HelperFrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const message = raw as { id: number; method: string };
          seen.push(message.method);
          const result =
            message.method === "hello"
              ? {
                  protocolVersion: 1,
                  helperVersion: "existing",
                  platform: "macos",
                  capabilities: [],
                }
              : { ok: true };
          socket.write(encodeHelperFrame({ jsonrpc: "2.0", id: message.id, result }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const { spawn, children } = processSpawner({ FAKE_HELPER_EXIT: "66" });
    const { supervisor } = make({ socketDir, spawn });
    const client = await supervisor.client();
    expect(supervisor.hello?.helperVersion).toBe("existing");
    expect(await client.request("apps.list", {})).toEqual({ ok: true });
    const exiting = children[0]!;
    if (exiting.exitCode === null) await new Promise((resolve) => exiting.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(supervisor.status.state).toBe("running");
    expect(seen).toEqual(["hello", "apps.list"]);
  });

  it("reports an unsafe socket directory without retrying", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner({ FAKE_HELPER_EXIT: "64" });
    const { supervisor } = make({ socketDir, spawn });
    const failure = { error: { details: { reason: "unsafe_socket_dir" } } };
    await expect(supervisor.client()).rejects.toMatchObject(failure);
    await expect(supervisor.client()).rejects.toMatchObject(failure);
    expect(children).toHaveLength(1);
    expect(supervisor.status).toMatchObject({ state: "error", reason: "unsafe_socket_dir" });
  });

  it("re-runs the install check once on a version mismatch, then gives up", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner({ FAKE_HELPER_PROTOCOL: "2" });
    const fake = installer();
    const { supervisor } = make({ socketDir, spawn, installer: fake.installer });
    await expect(supervisor.client()).rejects.toMatchObject({
      error: { details: { reason: "version_mismatch" } },
    });
    expect(fake.calls.ensure).toBe(2);
    expect(fake.calls.verify).toBe(2);
    expect(children).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(children.every((child) => !isAlive(child.pid))).toBe(true);
  });

  it("restarts a helper that crashes while running", async () => {
    const socketDir = tempDir();
    const { spawn, children } = processSpawner();
    const statuses: Array<ComputerUseHelperStatus> = [];
    const restarted = new Promise<void>((resolve) => {
      const { supervisor } = make({
        socketDir,
        spawn,
        onStatus: (status) => {
          statuses.push(status);
          if (status.state === "running" && children.length === 2) resolve();
        },
      });
      void supervisor.client().then((client) => client.request("test.crash", {}).catch(() => {}));
    });
    await restarted;
    expect(statuses.map((status) => status.state)).toEqual([
      "starting",
      "running",
      "error",
      "starting",
      "running",
    ]);
    expect(statuses[2]).toMatchObject({ reason: "helper_crashed" });
  });

  it("does not start on an unsupported platform", async () => {
    const { spawn, children } = processSpawner();
    const { supervisor } = make({ socketDir: tempDir(), spawn, supported: false });
    // Settings read this before anything starts.
    expect(supervisor.status).toEqual({ state: "stopped", reason: "unsupported_platform" });
    await expect(supervisor.client()).rejects.toMatchObject({
      error: { code: "computer_use_unavailable", details: { reason: "unsupported_platform" } },
    });
    expect(children).toHaveLength(0);
  });
});

class FakeTimers implements SupervisorTimers {
  private time = 0;
  private nextId = 0;
  private readonly queue: Array<{ id: number; at: number; callback: () => void }> = [];
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.nextId;
    this.queue.push({ id, at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    const index = this.queue.findIndex((entry) => entry.id === handle);
    if (index >= 0) this.queue.splice(index, 1);
  };
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      await flush();
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.time = next.at;
      next.callback();
    }
    this.time = end;
    await flush();
  }
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Children that never open a socket: each exits on its own or when killed. */
const fakeSpawner = (timers: FakeTimers, exitImmediately: boolean) => {
  const spawnedAt: Array<number> = [];
  const spawn: SpawnHelper = (): HelperChild => {
    spawnedAt.push(timers.now());
    let resolveExit: (exit: HelperExit) => void = () => {};
    const exited = new Promise<HelperExit>((resolve) => {
      resolveExit = resolve;
    });
    if (exitImmediately) resolveExit({ code: 1, signal: null });
    return { pid: undefined, kill: (signal) => resolveExit({ code: null, signal }), exited };
  };
  return { spawn, spawnedAt };
};

describe("HelperSupervisor restart policy", () => {
  const makeFake = (timers: FakeTimers, spawn: SpawnHelper, socketTimeoutMs?: number) =>
    make({
      socketDir: "/nonexistent",
      timers,
      spawn,
      checkSocket: async () => "missing",
      ...(socketTimeoutMs === undefined ? {} : { socketTimeoutMs }),
    });

  it("backs off 1, 2, 4, 8 s and stops after 5 failures in 2 minutes", async () => {
    const timers = new FakeTimers();
    const { spawn, spawnedAt } = fakeSpawner(timers, true);
    const { supervisor } = makeFake(timers, spawn);

    const first = supervisor.client();
    first.catch(() => {});
    await timers.advance(10 * 60_000);
    await expect(first).rejects.toMatchObject({
      error: { details: { reason: "helper_start_failed" } },
    });

    // Each attempt fails at its first 50 ms socket poll, then waits out the backoff.
    const gaps = spawnedAt.slice(1).map((at, index) => at - spawnedAt[index]! - 50);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(supervisor.status).toMatchObject({ state: "error", reason: "helper_crashed" });
    await expect(supervisor.client()).rejects.toMatchObject({
      error: { details: { reason: "helper_crashed" } },
    });
    expect(spawnedAt).toHaveLength(5);

    // "Restart helper" clears the cutoff.
    void supervisor.restart().catch(() => {});
    await timers.advance(100);
    expect(spawnedAt).toHaveLength(6);
  });

  it("waits 30 s once failures are spread out", async () => {
    const timers = new FakeTimers();
    const { spawn, spawnedAt } = fakeSpawner(timers, false);
    // Each attempt gives up after 40 s without a socket, so the window never fills.
    const { supervisor } = makeFake(timers, spawn, 40_000);

    void supervisor.client().catch(() => {});
    await timers.advance(6 * 40_000 + 60_000);

    const gaps = spawnedAt.slice(1, 6).map((at, index) => at - spawnedAt[index]!);
    expect(gaps).toEqual([41_000, 42_000, 44_000, 48_000, 70_000]);
    expect(supervisor.status.state).not.toBe("stopped");
    await supervisor.stop();
  });

  it("escalates to SIGKILL at 1.5 s and waits at most 2 s more for the socket", async () => {
    const timers = new FakeTimers();
    const signals: Array<string> = [];
    let resolveExit: (exit: HelperExit) => void = () => {};
    const exited = new Promise<HelperExit>((resolve) => {
      resolveExit = resolve;
    });
    const spawn: SpawnHelper = () => ({
      pid: 4242,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") resolveExit({ code: null, signal });
      },
      exited,
    });
    let socketAnswers = false;
    const { supervisor } = make({
      socketDir: "/nonexistent",
      timers,
      spawn,
      // Missing while starting; once stopping, it answers forever, so only the deadline ends the wait.
      checkSocket: async () => (socketAnswers ? "ready" : "missing"),
      probeSocket: async () => true,
    });
    void supervisor.client().catch(() => {});
    await timers.advance(10);
    socketAnswers = true;
    let stopped = false;
    void supervisor.stop().then(() => {
      stopped = true;
    });
    await timers.advance(1_499);
    expect(signals).toEqual(["SIGTERM"]);
    await timers.advance(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await timers.advance(1_900);
    expect(stopped).toBe(false);
    await timers.advance(200);
    expect(stopped).toBe(true);
  });

  it("never starts, not even a pending restart, while starts are held", async () => {
    const timers = new FakeTimers();
    const { spawn, spawnedAt } = fakeSpawner(timers, true);
    const { supervisor } = makeFake(timers, spawn);
    const first = supervisor.client().catch(() => {});
    await timers.advance(100);
    await first;
    expect(spawnedAt).toHaveLength(1);
    supervisor.setStartAllowed(false);
    await timers.advance(60_000);
    expect(spawnedAt).toHaveLength(1);
    await expect(supervisor.client()).rejects.toMatchObject({
      error: { details: { reason: "disabled" }, retryable: false },
    });
  });

  it("does not restart after an intentional stop", async () => {
    const timers = new FakeTimers();
    const { spawn, spawnedAt } = fakeSpawner(timers, true);
    const { supervisor } = makeFake(timers, spawn);
    const first = supervisor.client().catch(() => {});
    await timers.advance(100);
    await first;
    await supervisor.stop();
    await timers.advance(60_000);
    expect(spawnedAt).toHaveLength(1);
    expect(supervisor.status).toEqual({ state: "stopped" });
  });
});

describe("helperSpawnEnv", () => {
  it("drops inherited BUSYBOY_CU_* variables and keeps explicit overrides", () => {
    expect(
      helperSpawnEnv(
        { PATH: "/bin", BUSYBOY_CU_SOCKET_DIR: "/elsewhere", BUSYBOY_CU_DEV_CALLERS: "1" },
        { BUSYBOY_CU_SOCKET_DIR: "/test" },
      ),
    ).toEqual({ PATH: "/bin", BUSYBOY_CU_SOCKET_DIR: "/test" });
  });
});

describe("resolveHelperSocketPath", () => {
  it("falls back to TMPDIR when the default path is too long for a socket", () => {
    expect(resolveHelperSocketPath({ homeDirectory: "/Users/a", tmpDir: "/tmp", euid: 501 })).toBe(
      "/Users/a/Library/Application Support/BusyBoy/ComputerUse/run/helper.sock",
    );
    const home = `/Users/${"x".repeat(60)}`;
    expect(resolveHelperSocketPath({ homeDirectory: home, tmpDir: "/tmp/T", euid: 501 })).toBe(
      "/tmp/T/busyboy-cu-501/helper.sock",
    );
  });
});
