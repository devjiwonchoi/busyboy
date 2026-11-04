// @effect-diagnostics nodeBuiltinImport:off - Spawns the helper process and watches its socket.
// @effect-diagnostics globalDate:off - Crash-window timestamps use injectable timers.
// @effect-diagnostics globalTimers:off - Restart backoff and stop grace use injectable timers.
/**
 * Owns the computer-use helper process: installs and verifies it before every
 * launch, waits for its socket, connects, and restarts it after a crash with
 * backoff until it crashes too often.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ComputerUseHelperStatus } from "@t3tools/contracts";

import {
  HelperClient,
  HelperRequestError,
  type HelperHello,
  type HelperNotification,
} from "./HelperClient.ts";
import {
  HelperInstallError,
  type HelperInstallInfo,
  type HelperInstaller,
} from "./HelperInstall.ts";

/** Exit codes from `native/computer-use/crates/helper/src/lib.rs`. */
export const HELPER_EXIT = {
  ok: 0,
  unsafeSocketDir: 64,
  socketSetup: 65,
  alreadyRunning: 66,
  spawnFailed: 67,
} as const;

export const SOCKET_DIR_ENV = "BUSYBOY_CU_SOCKET_DIR";
export const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000] as const;
export const CRASH_WINDOW_MS = 2 * 60_000;
export const MAX_CRASHES_IN_WINDOW = 5;
export const STOP_GRACE_MS = 1_500;
const SOCKET_POLL_MS = 50;
const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;
/** `sun_path` minus the terminator, as in the helper. */
const MAX_SOCKET_PATH_BYTES = 103;

export interface HelperExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface HelperChild {
  readonly pid: number | undefined;
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<HelperExit>;
}

export type SpawnHelper = (
  executable: string,
  env: Readonly<Record<string, string | undefined>>,
) => HelperChild;

export interface SupervisorTimers {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export const systemTimers: SupervisorTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const spawnHelperProcess =
  (log: (line: string) => void): SpawnHelper =>
  (executable, env) => {
    const child = NodeChildProcess.spawn(executable, [], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim().length > 0) log(line);
    });
    const exited = new Promise<HelperExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: HELPER_EXIT.spawnFailed, signal: null }));
    });
    return {
      pid: child.pid,
      kill: (signal) => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
      exited,
    };
  };

/** Mirrors `socket::resolve_path` in the helper. */
export function resolveHelperSocketPath(input: {
  readonly homeDirectory: string;
  readonly socketDir?: string | undefined;
  readonly tmpDir?: string | undefined;
  readonly euid: number;
}): string {
  const dir =
    input.socketDir ??
    NodePath.join(input.homeDirectory, "Library/Application Support/BusyBoy/ComputerUse/run");
  const primary = NodePath.join(dir, "helper.sock");
  if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES || !input.tmpDir) return primary;
  return NodePath.join(input.tmpDir, `busyboy-cu-${input.euid}`, "helper.sock");
}

/** macOS 14 is Darwin 23. */
export function isComputerUseSupported(platform: NodeJS.Platform, release: string): boolean {
  return platform === "darwin" && Number.parseInt(release, 10) >= 23;
}

export const defaultSocketOwnerCheck = async (
  path: string,
): Promise<"ready" | "missing" | "unsafe"> => {
  const stat = await NodeFS.lstat(path).catch(() => null);
  if (stat === null) return "missing";
  if (!stat.isSocket()) return "missing";
  return stat.uid === NodeOS.userInfo().uid ? "ready" : "unsafe";
};

const unavailable = (reason: string, message: string) =>
  new HelperRequestError({
    code: "computer_use_unavailable",
    message,
    details: { reason },
    retryable: reason !== "unsupported_platform",
  });

interface Attempt {
  child: HelperChild | null;
  client: HelperClient | null;
  done: boolean;
}

class StartFailure extends Error {
  readonly reason: string;
  readonly terminal: boolean;
  constructor(reason: string, message: string, terminal: boolean) {
    super(message);
    this.reason = reason;
    this.terminal = terminal;
  }
}

export interface HelperSupervisorOptions {
  readonly installer: Pick<
    HelperInstaller,
    "ensureInstalled" | "verifyInstalled" | "executablePath"
  >;
  readonly socketPath: string;
  readonly clientVersion: string;
  readonly supported: boolean;
  /** Extra environment for the helper, e.g. `BUSYBOY_CU_SOCKET_DIR` in tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: SpawnHelper;
  readonly timers?: SupervisorTimers;
  readonly socketTimeoutMs?: number;
  readonly checkSocket?: (path: string) => Promise<"ready" | "missing" | "unsafe">;
  readonly onStatus?: (status: ComputerUseHelperStatus) => void;
  readonly onNotification?: (notification: HelperNotification) => void;
  readonly log?: (message: string) => void;
}

export class HelperSupervisor {
  private current: Attempt | null = null;
  private starting: Promise<HelperClient> | null = null;
  private terminal: { readonly reason: string; readonly detail: string } | null = null;
  /** Crash times inside the cutoff window. */
  private crashes: Array<number> = [];
  /** Picks the backoff step; a helper that ran for a whole window starts over. */
  private consecutiveCrashes = 0;
  private runningSince: number | null = null;
  private restartTimer: unknown = null;
  private mismatchReinstalled = false;
  private currentStatus: ComputerUseHelperStatus = { state: "stopped" };
  private readonly timers: SupervisorTimers;
  private readonly spawn: SpawnHelper;
  private readonly log: (message: string) => void;
  install: HelperInstallInfo | null = null;
  hello: HelperHello | null = null;

  private readonly options: HelperSupervisorOptions;

  constructor(options: HelperSupervisorOptions) {
    this.options = options;
    this.timers = options.timers ?? systemTimers;
    this.log = options.log ?? (() => {});
    this.spawn = options.spawn ?? spawnHelperProcess(this.log);
  }

  get status(): ComputerUseHelperStatus {
    return this.currentStatus;
  }

  /** The live connection, without starting anything. */
  get connected(): HelperClient | null {
    const client = this.current?.client;
    return client && !client.closed ? client : null;
  }

  /** The connected helper, starting it if needed. */
  client(): Promise<HelperClient> {
    if (this.current?.client && !this.current.client.closed) {
      return Promise.resolve(this.current.client);
    }
    if (this.starting) return this.starting;
    if (this.terminal) {
      return Promise.reject(unavailable(this.terminal.reason, this.terminal.detail));
    }
    if (this.restartTimer !== null) {
      return Promise.reject(
        unavailable("helper_crashed", "the helper is restarting after a crash"),
      );
    }
    const starting = this.start().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * Stops the helper. Its process is gone within about two seconds. `reset`
   * also clears the crash counter and any terminal error, as toggling the
   * setting does.
   */
  async stop(options: { readonly reset?: boolean } = {}): Promise<void> {
    this.cancelRestart();
    if (options.reset) this.reset();
    const attempt = this.current;
    this.current = null;
    // A start in progress sees `done` at its next step and gives up.
    this.starting = null;
    if (attempt) {
      attempt.done = true;
      attempt.client?.close();
      if (attempt.child) await this.terminate(attempt.child);
    }
    if (!this.terminal) this.setStatus({ state: "stopped" });
  }

  /** "Restart helper": clears the crash counter and starts again. */
  async restart(): Promise<HelperClient> {
    await this.stop({ reset: true });
    return this.client();
  }

  private reset(): void {
    this.terminal = null;
    this.crashes = [];
    this.consecutiveCrashes = 0;
    this.mismatchReinstalled = false;
  }

  private async start(): Promise<HelperClient> {
    if (!this.options.supported) {
      this.fatal("unsupported_platform", "computer use needs macOS 14 or later");
      throw unavailable("unsupported_platform", "computer use needs macOS 14 or later");
    }
    const attempt: Attempt = { child: null, client: null, done: false };
    this.current = attempt;
    this.setStatus({ state: "starting" });
    try {
      return await this.launch(attempt);
    } catch (error) {
      if (attempt.done) {
        throw error instanceof HelperRequestError
          ? error
          : unavailable("disabled", "the helper was stopped");
      }
      attempt.done = true;
      if (this.current === attempt) this.current = null;
      attempt.client?.close();
      if (attempt.child) void this.terminate(attempt.child);
      if (error instanceof StartFailure) {
        if (error.terminal) this.fatal(error.reason, error.message);
        else this.recordCrash(error.reason, error.message);
        throw unavailable(this.terminal?.reason ?? error.reason, error.message);
      }
      throw error;
    }
  }

  private async launch(attempt: Attempt): Promise<HelperClient> {
    try {
      this.install = await this.options.installer.ensureInstalled({
        beforeReplace: async () => {
          if (attempt.child) await this.terminate(attempt.child);
        },
      });
      await this.options.installer.verifyInstalled();
    } catch (error) {
      if (error instanceof HelperInstallError)
        throw new StartFailure(error.reason, error.message, true);
      throw new StartFailure("helper_install_failed", String(error), true);
    }
    this.checkCancelled(attempt);

    const child = this.spawn(this.options.installer.executablePath, this.options.env ?? {});
    attempt.child = child;
    let exit: HelperExit | null = null;
    void child.exited.then((value) => {
      exit = value;
      this.onChildExit(attempt, child, value);
    });

    const deadline =
      this.timers.now() + (this.options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS);
    const checkSocket = this.options.checkSocket ?? defaultSocketOwnerCheck;
    for (;;) {
      this.checkCancelled(attempt);
      const exited = exit as HelperExit | null;
      if (exited !== null && exited.code !== HELPER_EXIT.alreadyRunning) {
        if (exited.code === HELPER_EXIT.unsafeSocketDir) {
          throw new StartFailure(
            "unsafe_socket_dir",
            "the helper refused an unsafe socket directory",
            true,
          );
        }
        throw new StartFailure(
          "helper_start_failed",
          `the helper exited during startup (${describeExit(exited)})`,
          false,
        );
      }
      const socket = await checkSocket(this.options.socketPath);
      if (socket === "unsafe") {
        throw new StartFailure(
          "unsafe_socket_dir",
          "the helper socket belongs to another user",
          true,
        );
      }
      if (socket === "ready") {
        const connected = await this.connect(attempt);
        if (connected === "mismatch") {
          if (this.mismatchReinstalled) {
            throw new StartFailure(
              "version_mismatch",
              "the helper speaks another protocol version",
              true,
            );
          }
          // Re-run the install check once; a stale copy may be in place.
          this.mismatchReinstalled = true;
          if (attempt.child) await this.terminate(attempt.child);
          attempt.child = null;
          return this.launch(attempt);
        }
        if (connected !== "unreachable") return connected;
        // A stale socket from an earlier run stays until the new helper replaces it.
      }
      if (this.timers.now() >= deadline) {
        throw new StartFailure(
          "helper_start_failed",
          socket === "ready"
            ? "could not connect to the helper"
            : "the helper socket did not appear",
          false,
        );
      }
      await new Promise<void>((resolve) => this.timers.setTimeout(resolve, SOCKET_POLL_MS));
    }
  }

  private async connect(attempt: Attempt): Promise<HelperClient | "mismatch" | "unreachable"> {
    let connected: Awaited<ReturnType<typeof HelperClient.connect>>;
    try {
      connected = await HelperClient.connect({
        socketPath: this.options.socketPath,
        clientVersion: this.options.clientVersion,
        onNotification: (notification) => this.options.onNotification?.(notification),
        onClose: (error) => this.onConnectionClosed(attempt, error),
      });
    } catch (error) {
      if (error instanceof HelperRequestError && error.error.code === "version_mismatch") {
        return "mismatch";
      }
      return "unreachable";
    }
    if (attempt.done) {
      connected.client.close();
      this.checkCancelled(attempt);
    }
    attempt.client = connected.client;
    this.hello = connected.hello;
    this.runningSince = this.timers.now();
    this.setStatus({ state: "running" });
    return connected.client;
  }

  private checkCancelled(attempt: Attempt): void {
    if (attempt.done) throw unavailable("disabled", "the helper was stopped");
  }

  private onChildExit(attempt: Attempt, child: HelperChild, exit: HelperExit): void {
    if (attempt.child !== child) return;
    // 66: another helper owns the socket; the connection to it is what counts.
    if (exit.code === HELPER_EXIT.alreadyRunning) {
      attempt.child = null;
      return;
    }
    if (attempt.done || attempt.client === null) return;
    this.failRunning(attempt, `the helper exited (${describeExit(exit)})`);
  }

  private onConnectionClosed(attempt: Attempt, error: HelperRequestError): void {
    if (attempt.done || attempt.client === null) return;
    this.failRunning(attempt, error.message);
  }

  private failRunning(attempt: Attempt, detail: string): void {
    attempt.done = true;
    if (this.current === attempt) this.current = null;
    attempt.client?.close();
    if (attempt.child) void this.terminate(attempt.child);
    this.log(`computer-use helper failed: ${detail}`);
    this.recordCrash("helper_crashed", detail);
  }

  private recordCrash(reason: string, detail: string): void {
    const now = this.timers.now();
    if (this.runningSince !== null && now - this.runningSince >= CRASH_WINDOW_MS) {
      this.consecutiveCrashes = 0;
    }
    this.runningSince = null;
    this.consecutiveCrashes += 1;
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= MAX_CRASHES_IN_WINDOW) {
      this.fatal(
        "helper_crashed",
        `stopped restarting after ${this.crashes.length} failures in 2 minutes: ${detail}`,
      );
      return;
    }
    const delay =
      RESTART_BACKOFF_MS[Math.min(this.consecutiveCrashes, RESTART_BACKOFF_MS.length) - 1]!;
    this.setStatus({
      state: "error",
      reason,
      detail: `${detail}; restarting in ${delay / 1000} s`,
    });
    this.cancelRestart();
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      this.client().catch(() => undefined);
    }, delay);
  }

  private fatal(reason: string, detail: string): void {
    this.cancelRestart();
    this.terminal = { reason, detail };
    this.setStatus({ state: "error", reason, detail });
  }

  private cancelRestart(): void {
    if (this.restartTimer !== null) this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** SIGTERM, then SIGKILL after the grace period. */
  private async terminate(child: HelperChild): Promise<void> {
    child.kill("SIGTERM");
    let timer: unknown = null;
    const killed = await Promise.race([
      child.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = this.timers.setTimeout(() => resolve(true), STOP_GRACE_MS);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (killed) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  private setStatus(status: ComputerUseHelperStatus): void {
    const previous = this.currentStatus;
    this.currentStatus = status;
    if (
      previous.state !== status.state ||
      previous.reason !== status.reason ||
      previous.detail !== status.detail
    ) {
      this.options.onStatus?.(status);
    }
  }
}

function describeExit(exit: HelperExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
}
