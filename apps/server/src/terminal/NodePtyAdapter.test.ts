// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - spawns and polls a real shell to prove its process tree dies.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scheduler from "effect/Scheduler";
import { expect, vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import {
  descendantsOf,
  parseProcessTable,
  posixProcessTreeSignaler,
  type ProcessEntry,
  ProcessTreeSignalerRef,
  type ProcessTreeSignaler,
} from "./ProcessTree.ts";

function makeNativeProcess(pid = 42) {
  const events = new NodeEvents.EventEmitter();
  return {
    pid,
    _socket: new NodeNet.Socket(),
    _agent: { kill: vi.fn() },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => {
      events.on("data", callback);
      return {
        dispose: () => {
          events.off("data", callback);
        },
      };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
      events.on("exit", callback);
      return {
        dispose: () => {
          events.off("exit", callback);
        },
      };
    }),
    events,
  };
}

const spawn = vi.fn(() => makeNativeProcess());

function preparePendingProcess() {
  const nativeProcess = makeNativeProcess(0);
  const subscribed = Promise.withResolvers<void>();
  nativeProcess._socket.on("newListener", (event) => {
    if (event === "ready_datapipe") queueMicrotask(() => subscribed.resolve());
  });
  spawn.mockReturnValueOnce(nativeProcess);
  return { nativeProcess, subscribed: Effect.promise(() => subscribed.promise) };
}

const spawnInput = { shell: "powershell.exe", cwd: ".", cols: 80, rows: 24, env: {} };

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

// Fake pids like 42 must never reach the real process table.
const signalCalls: Array<[number, NodeJS.Signals]> = [];
let fakeTable: ReadonlyArray<ProcessEntry> = [];
const fakeTreeSignaler: ProcessTreeSignaler = {
  table: () => Promise.resolve(fakeTable),
  signal: (pid, signal) => {
    signalCalls.push([pid, signal]);
  },
};

const layerTestFor = (
  platform: NodeJS.Platform = "win32",
  treeSignaler: ProcessTreeSignaler = fakeTreeSignaler,
  nodePty: typeof import("node-pty") = fakeNodePty,
) =>
  NodePtyAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcess.Platform, platform),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(nodePty)),
        Layer.succeed(ProcessTreeSignalerRef, treeSignaler),
      ),
    ),
  );

const layerTest = layerTestFor();

it.effect("waits for the Windows PID without requiring output", () =>
  Effect.gen(function* () {
    const { nativeProcess, subscribed } = preparePendingProcess();
    const adapter = yield* PtyAdapter.PtyAdapter;
    let completed = false;
    const fiber = yield* adapter.spawn(spawnInput).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* subscribed;
    assert.isFalse(completed);
    nativeProcess.pid = 12345;
    nativeProcess._socket.emit("ready_datapipe");
    const process = yield* Fiber.join(fiber);
    assert.equal(process.pid, 12345);
    assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 1);

    const output: string[] = [];
    const exits: PtyAdapter.PtyExitEvent[] = [];
    const stopData = process.onData((data) => output.push(data));
    const stopExit = process.onExit((event) => exits.push(event));
    nativeProcess.events.emit("data", "first output");
    nativeProcess.events.emit("exit", { exitCode: 0 });
    assert.deepEqual(output, ["first output"]);
    assert.deepEqual(exits, [{ exitCode: 0, signal: null }]);
    stopData();
    stopExit();
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["exit", "close", "error", "invalid-pid"] as const)(
  "fails Windows startup on %s and cleans up",
  (failure) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const adapter = yield* PtyAdapter.PtyAdapter;
      const fiber = yield* adapter.spawn(spawnInput).pipe(Effect.result, Effect.forkChild);
      yield* subscribed;
      if (failure === "exit") nativeProcess.events.emit("exit", { exitCode: 1 });
      else if (failure === "error") nativeProcess._socket.emit("error", new Error("pipe failed"));
      else nativeProcess._socket.emit(failure === "close" ? "close" : "ready_datapipe");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PtyAdapter.PtySpawnError);
      assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
      assert.equal(nativeProcess._socket.listenerCount("error"), 0);
      assert.equal(nativeProcess._socket.listenerCount("close"), 0);
      assert.equal(nativeProcess.events.listenerCount("exit"), 0);
      assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("cancels the Windows connection without waiting for output", () =>
  Effect.gen(function* () {
    const { nativeProcess, subscribed } = preparePendingProcess();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const fiber = yield* adapter.spawn(spawnInput).pipe(Effect.forkChild);
    yield* subscribed;
    yield* Fiber.interrupt(fiber);
    assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
    assert.equal(nativeProcess.kill.mock.calls.length, 0);
    assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports an incompatible Windows readiness API instead of hanging", () =>
  Effect.gen(function* () {
    const nativeProcess = makeNativeProcess(0);
    Reflect.deleteProperty(nativeProcess, "_socket");
    spawn.mockReturnValueOnce(nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;
    const error = yield* adapter.spawn(spawnInput).pipe(Effect.flip);
    assert.instanceOf(error, PtyAdapter.PtySpawnError);
    assert.instanceOf(error.cause, Error);
    assert.equal(error.cause.message, "Windows PTY readiness socket is unavailable.");
    assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["win32", "linux", "darwin"] as const)(
  "terminates through node-pty using %s semantics",
  (platform) =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "test-shell",
        cwd: ".",
        cols: 80,
        rows: 24,
        env: {},
      });
      const nativeProcess = spawn.mock.results.at(-1)!.value;
      nativeProcess.kill.mockImplementation((signal?: string) => {
        if (platform === "win32" && signal) {
          throw new Error("Signals not supported on windows.");
        }
      });

      process.kill("SIGTERM");
      process.kill("SIGKILL");
      process.kill();
      // On POSIX each signal goes out, in order, after a process-table read.
      yield* Effect.promise(async () => {
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
      });

      assert.deepEqual(
        nativeProcess.kill.mock.calls,
        platform === "win32"
          ? [[undefined], [undefined], [undefined]]
          : [["SIGTERM"], ["SIGKILL"], [undefined]],
      );
    }).pipe(Effect.provide(layerTestFor(platform))),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.reject(cause)),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.Architecture, "x64"),
      ),
    ),
  ),
);

it.effect.each([2048, 8])(
  "preserves an exit during readiness handoff with scheduler budget %s",
  (budget) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const adapter = yield* PtyAdapter.PtyAdapter;
      const exits: PtyAdapter.PtyExitEvent[] = [];
      const fiber = yield* Effect.gen(function* () {
        const process = yield* adapter.spawn(spawnInput);
        process.onExit((event) => exits.push(event));
      }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
        Effect.provideService(Scheduler.PreventSchedulerYield, false),
        Effect.forkChild,
      );
      yield* subscribed;
      nativeProcess.pid = 12345;
      nativeProcess._socket.emit("ready_datapipe");
      nativeProcess.events.emit("exit", { exitCode: 0 });
      yield* Fiber.join(fiber);
      assert.equal(exits.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("replays an exit to late subscribers and respects unsubscription", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(spawnInput);
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    const removed = vi.fn();
    process.onExit(removed)();
    nativeProcess.events.emit("exit", { exitCode: 7, signal: 2 });
    const late = vi.fn();
    process.onExit(late);
    nativeProcess.events.emit("exit", { exitCode: 9 });
    assert.equal(removed.mock.calls.length, 0);
    assert.deepEqual(late.mock.calls, [[{ exitCode: 7, signal: 2 }]]);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["spawn", "interrupt"] as const)(
  "logs cleanup failures without replacing %s",
  (failure) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const killError = new Error("native kill failed");
      nativeProcess._agent.kill.mockImplementation(() => {
        throw killError;
      });
      const messages: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const adapter = yield* PtyAdapter.PtyAdapter;
      const fiber = yield* adapter
        .spawn(spawnInput)
        .pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.forkChild,
        );
      yield* subscribed;
      const spawnError = new Error("pipe failed");
      if (failure === "interrupt") yield* Fiber.interrupt(fiber);
      else nativeProcess._socket.emit("error", spawnError);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        if (failure === "interrupt") assert.isTrue(Cause.hasInterrupts(exit.cause));
        else {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, PtyAdapter.PtySpawnError);
          assert.equal(error.cause, spawnError);
        }
      }
      assert.equal(messages.length, 1);
      expect(messages[0]).toMatchObject([
        "failed to cancel Windows terminal startup",
        { terminalPid: 0, cause: { cause: killError } },
      ]);
      assert.equal(nativeProcess.events.listenerCount("exit"), 0);
      assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    }).pipe(Effect.provide(layerTest)),
);

it("finds descendants across process groups from the process table", () => {
  const table = parseProcessTable(
    [
      "    1     0     1 Mon Nov 10 09:00:00 2026",
      "   10     1    10 Mon Nov 10 09:00:01 2026",
      "   11    10    11 Mon Nov 10 09:00:02 2026",
      "   12    11    11 Mon Nov 10 09:00:03 2026",
      "   13    10    10 Mon Nov 10 09:00:04 2026",
      "   20     1    20 Mon Nov 10 09:00:05 2026",
    ].join("\n"),
  );
  assert.deepEqual(table[2], {
    pid: 11,
    ppid: 10,
    pgid: 11,
    startedAt: "Mon Nov 10 09:00:02 2026",
  });
  const pids = (roots: ReadonlyArray<number>) =>
    descendantsOf(table, roots)
      .map((entry) => entry.pid)
      .toSorted();
  assert.deepEqual(pids([10]), [11, 12, 13]);
  assert.deepEqual(pids([12, 20]), []);
});

const entry = (pid: number, ppid: number, pgid: number, startedAt: string): ProcessEntry => ({
  pid,
  ppid,
  pgid,
  startedAt,
});

/** Lets queued signalling, which waits on a process-table read, run. */
const flushSignals = Effect.promise(async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
});

it.effect("signals the process group and descendants, then force-kills orphans", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    signalCalls.length = 0;
    // 43 stays in the shell's group; a job-control shell moved 44 into its own.
    fakeTable = [entry(42, 1, 42, "t0"), entry(43, 42, 42, "t1"), entry(44, 42, 44, "t2")];
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({ ...spawnInput, shell: "/bin/zsh" });
    const nativeProcess = spawn.mock.results.at(-1)!.value;

    process.kill("SIGTERM");
    yield* flushSignals;
    assert.deepEqual(signalCalls, [
      [-42, "SIGTERM"],
      [43, "SIGTERM"],
      [44, "SIGTERM"],
    ]);
    assert.deepEqual(nativeProcess.kill.mock.calls, [["SIGTERM"]]);

    // The shell exits on SIGTERM. 43 ignores it and has started 45; 44 exited and
    // the OS gave its pid to an unrelated process, which must be left alone.
    signalCalls.length = 0;
    nativeProcess.events.emit("exit", { exitCode: 0, signal: 15 });
    fakeTable = [entry(43, 1, 42, "t1"), entry(44, 1, 44, "t9"), entry(45, 43, 42, "t3")];
    vi.advanceTimersByTime(3_000);
    yield* flushSignals;
    assert.deepEqual(signalCalls, [
      [-42, "SIGKILL"],
      [43, "SIGKILL"],
      [45, "SIGKILL"],
    ]);
    // The exited shell's pid is never signalled directly.
    assert.deepEqual(nativeProcess.kill.mock.calls, [["SIGTERM"]]);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.useRealTimers();
        fakeTable = [];
      }),
    ),
    Effect.provide(layerTestFor("darwin")),
  ),
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs a real detached shell behind the node-pty surface the adapter uses. */
const childProcessNodePty = {
  spawn: (shell: string, args: string[]) => {
    const child = NodeChildProcess.spawn(shell, args, { detached: true, stdio: "ignore" });
    return {
      pid: child.pid!,
      write: () => {},
      resize: () => {},
      kill: (signal?: string) => child.kill((signal ?? "SIGHUP") as NodeJS.Signals),
      onData: () => ({ dispose: () => {} }),
      onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
        const listener = (code: number | null) => callback({ exitCode: code ?? 0 });
        child.once("exit", listener);
        return { dispose: () => child.off("exit", listener) };
      },
    };
  },
} as unknown as typeof import("node-pty");

it.effect.skipIf(process.platform === "win32")(
  "leaves no descendants of a closed shell running",
  () =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      // One job stays in the shell's group; perl moves the other into its own group.
      const shell = yield* adapter.spawn({
        ...spawnInput,
        shell: "/bin/sh",
        args: ["-c", 'sleep 60 & perl -e "setpgrp(0, 0); sleep 60" & sleep 60 & wait'],
      });
      let descendants: ReadonlyArray<number> = [];
      for (let attempt = 0; attempt < 50 && descendants.length < 3; attempt++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        const table = yield* Effect.promise(() => posixProcessTreeSignaler.table());
        descendants = descendantsOf(table, [shell.pid]).map((entry) => entry.pid);
      }
      assert.isAtLeast(descendants.length, 3);

      try {
        shell.kill("SIGTERM");
        for (let attempt = 0; attempt < 50; attempt++) {
          if (!descendants.some(isAlive) && !isAlive(shell.pid)) break;
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        }
        assert.deepEqual(descendants.filter(isAlive), []);
        assert.isFalse(isAlive(shell.pid));
      } finally {
        for (const pid of [shell.pid, ...descendants])
          posixProcessTreeSignaler.signal(pid, "SIGKILL");
      }
    }).pipe(
      Effect.provide(layerTestFor(process.platform, posixProcessTreeSignaler, childProcessNodePty)),
    ),
);
