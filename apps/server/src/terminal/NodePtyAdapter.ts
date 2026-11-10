import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import { descendantsOf, ProcessTreeSignalerRef, type ProcessTreeSignaler } from "./ProcessTree.ts";

/**
 * After a graceful signal, how long jobs that outlived the shell get before
 * they are force-killed. The manager only escalates while the shell is alive.
 */
const ORPHAN_KILL_GRACE_MS = 3_000;

export class NodePtyModuleLoadError extends Schema.TaggedError<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

// node-pty stays external to the CLI bundle because it dlopens a native
// addon. Inside a Node single-executable, `import()` cannot load files from
// disk (only built-ins resolve), while `require` always reads the real
// filesystem, so both the module and its spawn-helper resolve through it.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

const loadNodePty: NodePtyModuleLoader = () =>
  Promise.resolve().then(() => requireForNodePty("node-pty") as typeof import("node-pty"));

export const NodePtyModuleLoaderRef = Context.Reference<NodePtyModuleLoader>(
  "server/terminal/NodePtyModuleLoader",
  { defaultValue: () => loadNodePty },
);

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * node-pty defers creation to avoid blocking on named pipes:
 * https://github.com/microsoft/node-pty/pull/885 Its public API has no
 * readiness event. The private ready_datapipe handler sets pid before our
 * listener runs.
 */
const waitForWindowsPid = (
  process: import("node-pty").IPty,
  trackedProcess: NodePtyProcess,
  shell: string,
) =>
  Effect.callback<void, PtyAdapter.PtySpawnError>((resume) => {
    const hasPid = () => Number.isInteger(process.pid) && process.pid > 0;
    const failure = (cause: unknown) =>
      Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell, cause }));

    if (hasPid()) {
      resume(Effect.void);
      return;
    }

    if (!("_socket" in process) || !(process._socket instanceof NodeNet.Socket)) {
      resume(failure(new Error("Windows PTY readiness socket is unavailable.")));
      return;
    }

    const socket = process._socket;
    const onReady = () => {
      cleanup();
      resume(
        hasPid()
          ? Effect.void
          : failure(new Error("Windows PTY became ready without a valid PID.")),
      );
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(failure(cause));
    };
    const onClose = () => onError(new Error("Windows PTY closed before its PID was available."));
    let stopExit = () => {};
    const cleanup = () => {
      socket.off("ready_datapipe", onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      stopExit();
    };
    socket.once("ready_datapipe", onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    stopExit = trackedProcess.onExit(({ exitCode }) =>
      onError(
        new Error(`Windows PTY exited before its PID was available (exit code ${exitCode}).`),
      ),
    );
    return Effect.sync(cleanup);
  });

/**
 * Cancels Windows startup without waiting for the first output, unlike public kill().
 * The private agent can cancel the pending connection before a child exists.
 */
const killStartingWindowsPty = (process: import("node-pty").IPty) =>
  Effect.try(() => {
    if (
      "_agent" in process &&
      typeof process._agent === "object" &&
      process._agent !== null &&
      "kill" in process._agent &&
      typeof process._agent.kill === "function"
    ) {
      process._agent.kill();
    } else {
      process.kill();
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to cancel Windows terminal startup", {
        terminalPid: process.pid,
        cause: error,
      }),
    ),
  );

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly exitSubscription: import("node-pty").IDisposable;
  private readonly treeSignaler: ProcessTreeSignaler;
  /**
   * Descendants seen while the shell was alive, by pid and start time; they
   * reparent away once it exits, and a pid the OS reuses is told apart.
   */
  private readonly trackedDescendants = new Map<number, string>();
  /** Signalling waits on a process-table read; this keeps kills in order. */
  private signalling: Promise<void> = Promise.resolve();
  private orphanKillTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    process: import("node-pty").IPty,
    platform: NodeJS.Platform,
    treeSignaler: ProcessTreeSignaler,
  ) {
    this.process = process;
    this.platform = platform;
    this.treeSignaler = treeSignaler;
    this.exitSubscription = process.onExit((event) => {
      if (this.exitEvent) return;
      this.exitEvent = { exitCode: event.exitCode, signal: event.signal ?? null };
      this.exitSubscription.dispose();
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    // node-pty terminates the Windows process tree without a POSIX signal.
    if (this.platform === "win32") {
      this.process.kill(undefined);
      return;
    }
    const treeSignal = (signal ?? "SIGHUP") as NodeJS.Signals;
    this.enqueue(async () => {
      const shellAlive = this.exitEvent === undefined;
      // The tree is read before the shell is signalled: once it exits, its jobs reparent.
      await this.signalTree(treeSignal, shellAlive);
      if (shellAlive && this.exitEvent === undefined) this.process.kill(signal);
    });
    if (treeSignal !== "SIGKILL") this.scheduleOrphanKill();
  }

  /** Runs `task` after earlier signalling; a failure is dropped (the shell may be gone). */
  private enqueue(task: () => Promise<void>): void {
    this.signalling = this.signalling.then(task).catch(() => undefined);
  }

  /**
   * Signals the shell's process group and every descendant, including jobs a
   * job-control shell moved into their own groups, so dev servers and other
   * background jobs do not outlive the terminal. A tracked pid is signalled
   * only while it still names the process seen before.
   */
  private async signalTree(signal: NodeJS.Signals, shellAlive: boolean): Promise<void> {
    const table = await this.treeSignaler.table();
    const live = new Map(table.map((entry) => [entry.pid, entry]));
    for (const [pid, startedAt] of this.trackedDescendants) {
      if (live.get(pid)?.startedAt !== startedAt) this.trackedDescendants.delete(pid);
    }
    const roots = shellAlive ? [this.pid] : [...this.trackedDescendants.keys()];
    for (const entry of descendantsOf(table, roots)) {
      this.trackedDescendants.set(entry.pid, entry.startedAt);
    }
    // Once the shell is gone its group id may be reused; signal it only while a
    // process we know still belongs to it.
    const groupLive =
      shellAlive ||
      [...this.trackedDescendants.keys()].some((pid) => live.get(pid)?.pgid === this.pid);
    if (groupLive) this.treeSignaler.signal(-this.pid, signal);
    for (const pid of this.trackedDescendants.keys()) this.treeSignaler.signal(pid, signal);
  }

  private scheduleOrphanKill(): void {
    if (this.orphanKillTimer !== undefined) return;
    // @effect-diagnostics-next-line globalTimers:off -- PtyProcess.kill is synchronous and fire-and-forget.
    this.orphanKillTimer = setTimeout(() => {
      this.orphanKillTimer = undefined;
      // Only jobs left behind: while the shell lives the manager owns escalation.
      if (this.exitEvent === undefined) return;
      this.enqueue(async () => {
        await this.signalTree("SIGKILL", false);
        this.trackedDescendants.clear();
      });
    }, ORPHAN_KILL_GRACE_MS);
    this.orphanKillTimer.unref?.();
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  disposeExitSubscription(): void {
    this.exitSubscription.dispose();
    this.exitListeners.clear();
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* () {
  const loadNodePtyModule = yield* NodePtyModuleLoaderRef;
  const treeSignaler = yield* ProcessTreeSignalerRef;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () => {
          const nativeProcess = nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          });
          return {
            nativeProcess,
            process: new NodePtyProcess(nativeProcess, platform, treeSignaler),
          };
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      if (platform === "win32") {
        yield* waitForWindowsPid(ptyProcess.nativeProcess, ptyProcess.process, input.shell).pipe(
          Effect.onError(() =>
            Effect.sync(() => ptyProcess.process.disposeExitSubscription()).pipe(
              Effect.andThen(killStartingWindowsPty(ptyProcess.nativeProcess)),
            ),
          ),
        );
      }
      return ptyProcess.process;
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
