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
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { COMPUTER_USE_TERMINAL_REASONS, type ComputerUseHelperStatus } from "@t3tools/contracts";

import {
  HelperClient,
  HelperRequestError,
  type HelperHello,
  type HelperNotification,
} from "./HelperClient.ts";
import {
  HELPER_EXECUTABLE,
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
/** How long a stop waits for the socket to go away before it escalates or gives up. */
export const SOCKET_GONE_TIMEOUT_MS = 2_000;
/** Connections closed without a `hello` reply, after exit 66, that mean a foreign helper. */
const FOREIGN_CLOSE_LIMIT = 2;
/**
 * The helper binds its socket within tens of ms, so the first half second
 * polls finely; a coarse poll would dominate the launch.
 */
export const SOCKET_POLL_MS = 5;
const SOCKET_POLL_FINE_FOR_MS = 500;
const SOCKET_POLL_SLOW_MS = 50;
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

/**
 * The helper's environment: BusyBoy's own, minus any inherited `BUSYBOY_CU_*`
 * (socket dir, dev switches), plus the supervisor's explicit overrides.
 */
export function helperSpawnEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.startsWith("BUSYBOY_CU_")) env[key] = value;
  }
  return { ...env, ...overrides };
}

export const spawnHelperProcess =
  (log: (line: string) => void): SpawnHelper =>
  (executable, env) => {
    const child = NodeChildProcess.spawn(executable, [], {
      env: helperSpawnEnv(process.env, env),
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

/**
 * Where the helper copy and its socket live. Development builds use their own
 * folder, so a dev run never replaces the installed app's helper or takes its
 * socket. The copy keeps its TCC grants there because macOS matches them by
 * the helper's signature, not its path.
 */
export function helperRootDir(homeDirectory: string, development: boolean): string {
  return NodePath.join(
    homeDirectory,
    `Library/Application Support/BusyBoy/${development ? "ComputerUse-dev" : "ComputerUse"}`,
  );
}

/** Mirrors `socket::resolve_path` in the helper. */
export function resolveHelperSocketPath(input: {
  readonly homeDirectory: string;
  readonly socketDir?: string | undefined;
  readonly tmpDir?: string | undefined;
  readonly euid: number;
  /** Development builds pass their own name so the two never share a socket. */
  readonly development?: boolean;
}): string {
  const dir =
    input.socketDir ??
    NodePath.join(input.homeDirectory, "Library/Application Support/BusyBoy/ComputerUse/run");
  const primary = NodePath.join(dir, "helper.sock");
  if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES || !input.tmpDir) return primary;
  const name = input.development ? `busyboy-cu-dev-${input.euid}` : `busyboy-cu-${input.euid}`;
  return NodePath.join(input.tmpDir, name, "helper.sock");
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

/** True when the socket accepts a connection. */
export const defaultSocketProbe = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.createConnection(path);
    const finish = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });

const execText = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => resolve(error === null ? stdout : ""),
    );
  });

/**
 * The helper process listening on `path`, found with lsof. Only a process named
 * like the helper counts, and never BusyBoy itself.
 */
export const defaultFindSocketOwner = async (path: string): Promise<number | null> => {
  const listing = await execText("lsof", ["-n", "-P", "-U", "-F", "pn"]);
  let pid: number | null = null;
  const owners = new Set<number>();
  for (const line of listing.split("\n")) {
    if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith("n") && line.slice(1) === path && pid !== null) owners.add(pid);
  }
  owners.delete(process.pid);
  for (const owner of owners) {
    const command = (await execText("ps", ["-o", "comm=", "-p", String(owner)])).trim();
    if (NodePath.basename(command) === HELPER_EXECUTABLE) return owner;
  }
  return null;
};

/** `process.kill`: throws when the process is gone or not ours. */
export type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => void;

const unavailable = (reason: string, message: string, terminal = false) =>
  new HelperRequestError({
    code: "computer_use_unavailable",
    message,
    details: { reason },
    retryable: !terminal && !COMPUTER_USE_TERMINAL_REASONS.has(reason),
  });

interface Attempt {
  child: HelperChild | null;
  client: HelperClient | null;
  /** `hello.pid`: the process serving the socket, ours or one found after exit 66. */
  pid: number | null;
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

const UNSUPPORTED_STATUS: ComputerUseHelperStatus = {
  state: "stopped",
  reason: "unsupported_platform",
};

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
  /** True when the socket accepts a connection. */
  readonly probeSocket?: (path: string) => Promise<boolean>;
  /** The process listening on the socket, for a helper that never said hello to us. */
  readonly findSocketOwner?: (path: string) => Promise<number | null>;
  readonly signalProcess?: SignalProcess;
  readonly handshakeTimeoutMs?: number;
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
  /** While false (computer use is off), nothing starts the helper, not even a pending restart. */
  private startAllowed = true;
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
    // Lets settings tell "not macOS 14+" apart from "not started yet".
    if (!options.supported) this.currentStatus = UNSUPPORTED_STATUS;
  }

  /** Turning computer use off holds starts first, so a pending restart cannot slip in. */
  setStartAllowed(allowed: boolean): void {
    this.startAllowed = allowed;
    if (!allowed) this.cancelRestart();
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
    if (!this.startAllowed) {
      return Promise.reject(unavailable("disabled", "computer use is turned off", true));
    }
    if (this.terminal) {
      return Promise.reject(unavailable(this.terminal.reason, this.terminal.detail, true));
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
      await this.terminateAttempt(attempt);
    }
    if (!this.terminal) {
      this.setStatus(this.options.supported ? { state: "stopped" } : UNSUPPORTED_STATUS);
    }
  }

  /**
   * "Restart helper": clears the crash counter and starts again. A foreign
   * helper holding the socket is stopped first, if it runs as this user.
   */
  async restart(): Promise<HelperClient> {
    const foreign = this.terminal?.reason === "helper_foreign_instance";
    await this.stop({ reset: true });
    if (foreign) await this.stopSocketOwner();
    return this.client();
  }

  /**
   * Stops the helper and starts a fresh one. This is not a crash: the crash
   * counter and backoff stay as they are. Used after Accessibility is granted,
   * because macOS may keep refusing accessibility calls from a process that
   * started without the grant.
   */
  async recycle(): Promise<HelperClient> {
    await this.stop();
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
    const attempt: Attempt = { child: null, client: null, pid: null, done: false };
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
      void this.terminateAttempt(attempt);
      if (error instanceof StartFailure) {
        if (error.terminal) this.fatal(error.reason, error.message);
        else this.recordCrash(error.reason, error.message);
        throw unavailable(
          this.terminal?.reason ?? error.reason,
          error.message,
          this.terminal !== null,
        );
      }
      throw error;
    }
  }

  private async launch(attempt: Attempt): Promise<HelperClient> {
    try {
      this.install = await this.options.installer.ensureInstalled({
        // Stop any running helper, ours or not, before its bundle is replaced.
        beforeReplace: async () => {
          if (attempt.child || attempt.pid !== null) await this.terminateAttempt(attempt);
          else await this.stopSocketOwner(this.hello?.pid ?? null);
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
    const polledSince = this.timers.now();
    let alreadyRunning = false;
    let closedWithoutReply = 0;
    for (;;) {
      this.checkCancelled(attempt);
      const exited = exit as HelperExit | null;
      if (exited?.code === HELPER_EXIT.alreadyRunning) alreadyRunning = true;
      if (alreadyRunning && closedWithoutReply >= FOREIGN_CLOSE_LIMIT) {
        // Not a crash: a helper this app did not launch (say, a dev build left
        // by an old launcher) holds the socket and rejects us.
        throw new StartFailure(
          "helper_foreign_instance",
          "another BusyBoy Computer Use helper owns the socket and refuses this app; restart the helper to stop it",
          true,
        );
      }
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
        if (connected === "closed") closedWithoutReply += 1;
        else if (connected !== "unreachable") return connected;
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
      const poll =
        this.timers.now() - polledSince < SOCKET_POLL_FINE_FOR_MS
          ? SOCKET_POLL_MS
          : SOCKET_POLL_SLOW_MS;
      await new Promise<void>((resolve) => this.timers.setTimeout(resolve, poll));
    }
  }

  private async connect(
    attempt: Attempt,
  ): Promise<HelperClient | "mismatch" | "unreachable" | "closed"> {
    let connected: Awaited<ReturnType<typeof HelperClient.connect>>;
    try {
      connected = await HelperClient.connect({
        socketPath: this.options.socketPath,
        clientVersion: this.options.clientVersion,
        onNotification: (notification) => this.options.onNotification?.(notification),
        onClose: (error) => this.onConnectionClosed(attempt, error),
        ...(this.options.handshakeTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.handshakeTimeoutMs }),
      });
    } catch (error) {
      if (error instanceof HelperRequestError && error.error.code === "version_mismatch") {
        return "mismatch";
      }
      const reason =
        error instanceof HelperRequestError
          ? (error.error.details as { reason?: unknown } | undefined)?.reason
          : undefined;
      return reason === "helper_disconnected" ? "closed" : "unreachable";
    }
    if (attempt.done) {
      connected.client.close();
      this.checkCancelled(attempt);
    }
    attempt.client = connected.client;
    attempt.pid = connected.hello.pid ?? null;
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
    void this.terminateAttempt(attempt);
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
    if (!this.startAllowed) return;
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      if (this.startAllowed) this.client().catch(() => undefined);
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

  /** Stops what an attempt runs: its child if it has one, else the pid it said hello from. */
  private async terminateAttempt(attempt: Attempt): Promise<void> {
    const child = attempt.child;
    if (child) {
      await this.terminate(child, attempt.pid);
    } else if (attempt.pid !== null) {
      await this.terminatePid(attempt.pid);
    }
  }

  /**
   * SIGTERM, then SIGKILL after the grace period; then wait for the socket to
   * go. Stage 1 forwards SIGTERM to the serving process, and the serving
   * process stops itself when stage 1 dies, so the socket is the real signal.
   */
  private async terminate(child: HelperChild, servingPid: number | null = null): Promise<void> {
    child.kill("SIGTERM");
    // The child may be one that exited 66 (or is about to) while another serves.
    const other = servingPid !== null && servingPid !== child.pid ? servingPid : null;
    if (other !== null && this.ownsProcess(other)) this.signal(other, "SIGTERM");
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
    if (await this.waitForSocketGone(SOCKET_GONE_TIMEOUT_MS)) return;
    if (other !== null && this.ownsProcess(other)) {
      this.signal(other, "SIGKILL");
      await this.waitForSocketGone(SOCKET_GONE_TIMEOUT_MS, other);
    }
  }

  /** A helper BusyBoy did not spawn: SIGTERM, wait for the socket to go, then SIGKILL. */
  private async terminatePid(pid: number): Promise<void> {
    if (!this.ownsProcess(pid)) return;
    this.signal(pid, "SIGTERM");
    if (await this.waitForSocketGone(SOCKET_GONE_TIMEOUT_MS, pid)) return;
    if (this.ownsProcess(pid)) this.signal(pid, "SIGKILL");
    await this.waitForSocketGone(SOCKET_GONE_TIMEOUT_MS, pid);
  }

  /** Stops whatever listens on the socket, when it is a helper running as this user. */
  private async stopSocketOwner(hint: number | null = null): Promise<void> {
    const find = this.options.findSocketOwner ?? defaultFindSocketOwner;
    const pid = hint ?? (await find(this.options.socketPath).catch(() => null));
    if (pid !== null) await this.terminatePid(pid);
  }

  /** Same user: signal 0 succeeds only for live processes we may signal. */
  private ownsProcess(pid: number): boolean {
    try {
      this.signal(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private signal(pid: number, signal: NodeJS.Signals | 0): void {
    if (this.options.signalProcess) this.options.signalProcess(pid, signal);
    else process.kill(pid, signal);
  }

  /** True once the socket file is gone or refuses connections, or `pid` has exited. */
  private async waitForSocketGone(timeoutMs: number, pid: number | null = null): Promise<boolean> {
    const checkSocket = this.options.checkSocket ?? defaultSocketOwnerCheck;
    const probe = this.options.probeSocket ?? defaultSocketProbe;
    const deadline = this.timers.now() + timeoutMs;
    for (;;) {
      if (pid !== null && !this.ownsProcess(pid)) return true;
      const socket = await checkSocket(this.options.socketPath).catch(() => "missing" as const);
      if (socket !== "ready") return true;
      if (!(await probe(this.options.socketPath).catch(() => false))) return true;
      if (this.timers.now() >= deadline) return false;
      await new Promise<void>((resolve) => this.timers.setTimeout(resolve, SOCKET_POLL_MS));
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
