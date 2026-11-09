// @effect-diagnostics nodeBuiltinImport:off - Reads the OS release and user id for helper paths.
// @effect-diagnostics globalTimers:off - The idle stop timer is injectable for tests.
/**
 * Desktop end of the server's computer-use channel. The server writes request
 * and configure lines; this routes requests to the helper (starting it lazily
 * while enabled) and writes response, notification, and status lines back.
 */
import {
  COMPUTER_USE_TERMINAL_REASONS,
  ComputerUseErrorCode,
  DESKTOP_COMPUTER_USE_METHODS,
  DesktopComputerUseCommand,
  DesktopComputerUseEvent,
  type ComputerUseErrorObject,
  type ComputerUseHelperStatus,
  type DesktopComputerUseCommand as DesktopComputerUseCommandType,
  type DesktopComputerUseEvent as DesktopComputerUseEventType,
  type DesktopComputerUseHelperInfo,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import { makeElectronOverlay, type ComputerUseTrafficObserver } from "./ComputerUseOverlay.ts";
import { HelperRequestError, type HelperClient } from "./HelperClient.ts";
import { HELPER_BUNDLE_NAME, HelperInstaller } from "./HelperInstall.ts";
import {
  HelperSupervisor,
  SOCKET_DIR_ENV,
  helperRootDir,
  isComputerUseSupported,
  resolveHelperSocketPath,
  systemTimers,
  type SupervisorTimers,
} from "./HelperSupervisor.ts";

/** Stop the helper after this long without a session or a request. */
export const IDLE_STOP_MS = 10 * 60_000;
/** Turning computer use off ends sessions and stops the helper within this, together. */
export const DISABLE_DEADLINE_MS = 2_000;

const isErrorCode = Schema.is(ComputerUseErrorCode);

/** Helper-level failures: tool callers see them as computer use being unavailable. */
const HELPER_LEVEL_CODES: ReadonlySet<string> = new Set([
  "invalid_frame",
  "version_mismatch",
  "internal_error",
]);

const unavailableFor = (reason: string, message: string): ComputerUseErrorObject => ({
  code: "computer_use_unavailable",
  message,
  details: { reason },
  retryable: false,
});

/** The error a tool caller gets. Helper status keeps the raw reason. */
export const toErrorObject = (error: unknown): ComputerUseErrorObject => {
  if (!(error instanceof HelperRequestError)) {
    return unavailableFor("internal_error", String(error));
  }
  const { code, message, hint, details, retryable } = error.error;
  if (!isErrorCode(code) || HELPER_LEVEL_CODES.has(code)) {
    return unavailableFor(isErrorCode(code) ? code : "internal_error", `${code}: ${message}`);
  }
  const reason =
    code === "computer_use_unavailable" && typeof details === "object" && details !== null
      ? (details as { reason?: unknown }).reason
      : undefined;
  return {
    code,
    message,
    retryable:
      retryable && !(typeof reason === "string" && COMPUTER_USE_TERMINAL_REASONS.has(reason)),
    ...(hint === undefined ? {} : { hint }),
    ...(details === undefined ? {} : { details }),
  };
};

const cancelledBeforeSendError = new HelperRequestError({
  code: "stopped",
  message: "the request was cancelled before it reached the helper",
  retryable: false,
});

const notRunningError = new HelperRequestError({
  code: "computer_use_unavailable",
  message: "the helper is not running",
  details: { reason: "helper_unreachable" },
  retryable: true,
});

const disabledError: ComputerUseErrorObject = {
  code: "computer_use_unavailable",
  message: "computer use is turned off in BusyBoy settings",
  details: { reason: "disabled" },
  retryable: false,
};

type Supervisor = Pick<
  HelperSupervisor,
  | "client"
  | "connected"
  | "stop"
  | "restart"
  | "recycle"
  | "status"
  | "install"
  | "hello"
  | "setStartAllowed"
>;

const PERMISSIONS_STATUS = "permissions.status";

/** What a helper reply says about Accessibility, if anything. */
const accessibilityIn = (
  method: string,
  outcome: { readonly result: unknown } | { readonly error: unknown },
): "granted" | "missing" | null => {
  if ("result" in outcome) {
    if (method !== PERMISSIONS_STATUS) return null;
    const value = (outcome.result as { accessibility?: unknown } | null)?.accessibility;
    if (value === "granted") return "granted";
    return value === "not_granted" ? "missing" : null;
  }
  if (!(outcome.error instanceof HelperRequestError)) return null;
  if (outcome.error.error.code !== "permission_required") return null;
  const missing = (outcome.error.error.details as { missing?: unknown } | undefined)?.missing;
  return Array.isArray(missing) && missing.includes("accessibility") ? "missing" : null;
};

interface Session {
  readonly threadId: string;
  readonly turnId: string;
}

const sessionOf = (params: unknown): Session | null => {
  if (typeof params !== "object" || params === null) return null;
  const { threadId, turnId } = params as Record<string, unknown>;
  return typeof threadId === "string" && typeof turnId === "string" ? { threadId, turnId } : null;
};

/** The routing rules, without Effect or fds, so tests can drive them directly. */
export class ComputerUseRouter {
  private enabled = false;
  private readonly sessions = new Map<string, Session>();
  /** Server request id → helper request id, for `cancel {requestId}`. */
  private readonly inFlight = new Map<number, number>();
  /** Server ids waiting for the helper to start, and those cancelled meanwhile. */
  private readonly awaitingSend = new Set<number>();
  private readonly cancelledBeforeSend = new Set<number>();
  private idleTimer: unknown = null;
  /** The helper connection that last said Accessibility is not granted. */
  private accessibilityMissing: HelperClient | null = null;
  /** A restart after Accessibility was granted; requests wait for it. */
  private recycling: Promise<void> | null = null;
  private readonly timers: SupervisorTimers;
  private readonly idleStopMs: number;

  private readonly supervisor: Supervisor;
  private readonly emit: (event: DesktopComputerUseEventType) => void;
  private readonly observer: ComputerUseTrafficObserver | null;

  constructor(
    supervisor: Supervisor,
    emit: (event: DesktopComputerUseEventType) => void,
    options: {
      readonly timers?: SupervisorTimers;
      readonly idleStopMs?: number;
      /** Sees requests, responses, and settings changes; the overlay uses it. */
      readonly observer?: ComputerUseTrafficObserver;
    } = {},
  ) {
    this.supervisor = supervisor;
    this.emit = emit;
    this.timers = options.timers ?? systemTimers;
    this.idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
    this.observer = options.observer ?? null;
    // Starts disabled: nothing may start the helper until configure(true).
    supervisor.setStartAllowed(false);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get activeSessions(): ReadonlyArray<Session> {
    return [...this.sessions.values()];
  }

  statusEvent(
    status: ComputerUseHelperStatus = this.supervisor.status,
  ): DesktopComputerUseEventType {
    return { type: "status", ...status };
  }

  /**
   * Every helper status change. A new connection, a crash, or a stop means the
   * helper no longer has our sessions, so forget them (and let idle stop run).
   */
  helperStatusChanged(status: ComputerUseHelperStatus): DesktopComputerUseEventType {
    if (status.state !== "starting") this.sessions.clear();
    return this.statusEvent(status);
  }

  async handle(command: DesktopComputerUseCommandType): Promise<void> {
    if (command.type === "configure") {
      await this.configure(command.enabled);
      return;
    }
    const { id, method, params } = command;
    try {
      const result = await this.route(id, method, params, command.passive === true);
      this.observe((observer) => observer.response(id, method, params, { result }));
      this.emit({ type: "response", id, result });
    } catch (error) {
      const errorObject = toErrorObject(error);
      this.observe((observer) => observer.response(id, method, params, { error: errorObject }));
      this.emit({ type: "response", id, error: errorObject });
    } finally {
      this.inFlight.delete(id);
      this.awaitingSend.delete(id);
      this.cancelledBeforeSend.delete(id);
    }
  }

  async configure(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.observe((observer) => observer.configured(enabled));
    this.clearIdle();
    if (enabled) {
      this.supervisor.setStartAllowed(true);
      // Toggling also clears a crash cutoff or other terminal error.
      await this.supervisor.stop({ reset: true });
      return;
    }
    // Hold starts first, so a pending restart cannot run while we stop.
    this.supervisor.setStartAllowed(false);
    await this.withDeadline(DISABLE_DEADLINE_MS, async (remaining) => {
      await this.endAllSessions(remaining());
      await this.supervisor.stop({ reset: true });
    });
  }

  /** A backend (re)attached: turns from the previous one are gone. */
  async serverAttached(): Promise<void> {
    await this.endAllSessions();
  }

  async shutdown(): Promise<void> {
    this.enabled = false;
    this.observe((observer) => observer.configured(false));
    this.clearIdle();
    this.supervisor.setStartAllowed(false);
    await this.withDeadline(DISABLE_DEADLINE_MS, async (remaining) => {
      await this.endAllSessions(remaining());
      await this.supervisor.stop();
    });
  }

  /** Runs `work` but returns by `ms`; the rest finishes in the background. */
  private async withDeadline(
    ms: number,
    work: (remaining: () => number) => Promise<void>,
  ): Promise<void> {
    const end = this.timers.now() + ms;
    let timer: unknown = null;
    const expired = new Promise<void>((resolve) => {
      timer = this.timers.setTimeout(resolve, ms);
    });
    const running = work(() => Math.max(0, end - this.timers.now())).catch(() => undefined);
    await Promise.race([running, expired]);
    this.timers.clearTimeout(timer);
  }

  /** The overlay is cosmetic: its failures never affect routing. */
  private observe(use: (observer: ComputerUseTrafficObserver) => void): void {
    if (this.observer === null) return;
    try {
      use(this.observer);
    } catch {
      // Ignored on purpose.
    }
  }

  private info(): DesktopComputerUseHelperInfo {
    const install = this.supervisor.install;
    const version = install?.version ?? undefined;
    const helperVersion = this.supervisor.hello?.helperVersion;
    return {
      status: this.supervisor.status,
      ...(install ? { installedPath: install.path } : {}),
      ...(version ? { installedVersion: version } : {}),
      ...(helperVersion ? { helperVersion } : {}),
    };
  }

  private async route(
    id: number,
    method: string,
    params: unknown,
    passive: boolean,
  ): Promise<unknown> {
    if (method === DESKTOP_COMPUTER_USE_METHODS.helperStatus) return this.info();
    if (!this.enabled) throw new HelperRequestError(disabledError);
    // Only now is the request accepted, so a rejected one never flashes the overlay.
    this.observe((observer) => observer.request(id, method, params));
    if (passive) {
      // Polling: answer from a running helper only, and leave its idle clock alone.
      const client = this.supervisor.connected;
      if (!client) throw notRunningError;
      return this.sendTracked(client, method, params);
    }
    this.touch();
    if (method === DESKTOP_COMPUTER_USE_METHODS.helperRestart) {
      await this.supervisor.restart();
      return this.info();
    }

    if (method === "cancel" || method === "session.end") {
      // Nothing to cancel or end on a helper that is not running.
      const client = this.supervisor.connected;
      if (method === "session.end") {
        const session = sessionOf(params);
        if (session) this.sessions.delete(session.turnId);
      }
      if (method === "cancel" && this.cancelBeforeSend(params)) return {};
      if (!client) return {};
      return client.send(method, method === "cancel" ? this.cancelParams(params) : params).response;
    }

    this.awaitingSend.add(id);
    const client = await this.readyClient();
    this.awaitingSend.delete(id);
    if (this.cancelledBeforeSend.has(id)) throw cancelledBeforeSendError;
    const result = await this.sendTracked(client, method, params, (helperId) =>
      this.inFlight.set(id, helperId),
    );
    if (method === "session.begin") {
      const session = sessionOf(params);
      if (session) this.sessions.set(session.turnId, session);
    }
    return result;
  }

  /**
   * The helper to send a request to. macOS may keep refusing accessibility
   * calls from a helper that started before Accessibility was granted. So
   * while the running helper has said the grant is missing, ask it again
   * first, and start a fresh helper once the grant is there.
   */
  private readyClient(): Promise<HelperClient> {
    // The usual case: nothing to check, so no extra wait.
    if (this.recycling === null && this.accessibilityMissing === null) {
      return this.supervisor.client();
    }
    return this.clientAfterGrantCheck();
  }

  private async clientAfterGrantCheck(): Promise<HelperClient> {
    if (this.recycling) await this.recycling;
    const client = await this.supervisor.client();
    if (client !== this.accessibilityMissing) return client;
    const status = await client.request(PERMISSIONS_STATUS, {}).catch(() => null);
    if (accessibilityIn(PERMISSIONS_STATUS, { result: status }) !== "granted") return client;
    await this.recycleForAccessibility();
    return this.supervisor.client();
  }

  /** Sends one request and remembers what its reply says about Accessibility. */
  private async sendTracked(
    client: HelperClient,
    method: string,
    params: unknown,
    onSent?: (helperId: number) => void,
  ): Promise<unknown> {
    const sent = client.send(method, params);
    onSent?.(sent.id);
    let result: unknown;
    try {
      result = await sent.response;
    } catch (error) {
      await this.accessibilitySeen(client, accessibilityIn(method, { error }));
      throw error;
    }
    await this.accessibilitySeen(client, accessibilityIn(method, { result }));
    return result;
  }

  private async accessibilitySeen(
    client: HelperClient,
    state: "granted" | "missing" | null,
  ): Promise<void> {
    if (state === "missing") this.accessibilityMissing = client;
    else if (state === "granted" && client === this.accessibilityMissing) {
      await this.recycleForAccessibility();
    }
  }

  /** Not a crash: the supervisor keeps its crash count. */
  private recycleForAccessibility(): Promise<void> {
    this.accessibilityMissing = null;
    this.recycling ??= this.supervisor
      .recycle()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.recycling = null;
      });
    return this.recycling;
  }

  /** A cancel for a request still waiting for the helper: answer it `stopped` without sending. */
  private cancelBeforeSend(params: unknown): boolean {
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== "number" || !this.awaitingSend.has(requestId)) return false;
    this.cancelledBeforeSend.add(requestId);
    return true;
  }

  /** Server ids mean nothing to the helper; translate, or cancel nothing. */
  private cancelParams(params: unknown): unknown {
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== "number") return {};
    const helperId = this.inFlight.get(requestId);
    // An id the helper never saw: cancel an id no request uses.
    return { requestId: helperId ?? -1 };
  }

  private async endAllSessions(timeoutMs = DISABLE_DEADLINE_MS): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const client = this.supervisor.connected;
    if (!client || sessions.length === 0) return;
    let timer: unknown = null;
    await Promise.race([
      Promise.all(
        sessions.map((session) => client.request("session.end", session).catch(() => undefined)),
      ),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    this.timers.clearTimeout(timer);
  }

  private touch(): void {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      if (this.sessions.size > 0) {
        this.touch();
        return;
      }
      void this.supervisor.stop();
    }, this.idleStopMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopComputerUseEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopComputerUseCommand));
const lineEncoder = new TextEncoder();

export class ComputerUseChannelHost extends Context.Service<
  ComputerUseChannelHost,
  {
    /** Event lines for the backend's computer-use input fd. */
    readonly events: Stream.Stream<Uint8Array>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    /** Ends sessions and stops the helper; part of app quit. */
    readonly shutdown: Effect.Effect<void>;
  }
>()("@t3tools/desktop/computerUse/ComputerUseChannelHost") {}

const { logWarning, logInfo } = DesktopObservability.makeComponentLogger("desktop-computer-use");

const resolveBundledHelperPath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const relative = environment.path.join("computer-use", HELPER_BUNDLE_NAME);
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/computer-use/target/bundle/debug",
          HELPER_BUNDLE_NAME,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, relative)]
      : environment.resolveResourcePathCandidates(relative);
  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }
  return Option.none<string>();
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const bundledPath = yield* resolveBundledHelperPath;
  const outbox = yield* PubSub.unbounded<DesktopComputerUseEventType>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const emit = (event: DesktopComputerUseEventType) => runFork(PubSub.publish(outbox, event));
  const log = (message: string) => runFork(logInfo(message));

  const supported = isComputerUseSupported(environment.platform, NodeOS.release());
  const helperRoot = helperRootDir(environment.homeDirectory, environment.isDevelopment);
  const socketPath = resolveHelperSocketPath({
    homeDirectory: environment.homeDirectory,
    ...(environment.isDevelopment ? { socketDir: environment.path.join(helperRoot, "run") } : {}),
    tmpDir: process.env.TMPDIR,
    euid: supported ? NodeOS.userInfo().uid : 0,
    development: environment.isDevelopment,
  });
  const installer = new HelperInstaller({
    bundledPath: Option.getOrNull(bundledPath),
    installRoot: helperRoot,
  });
  const supervisor = new HelperSupervisor({
    installer,
    socketPath,
    // The helper's default socket dir is the installed app's; hand dev builds the final one.
    ...(environment.isDevelopment
      ? { env: { [SOCKET_DIR_ENV]: environment.path.dirname(socketPath) } }
      : {}),
    clientVersion: environment.appVersion,
    supported,
    log,
    onStatus: (status) => {
      if (status.state === "error") {
        runFork(logWarning("computer-use helper unavailable", { ...status }));
      }
      emit(router.helperStatusChanged(status));
    },
    onNotification: (notification) => {
      try {
        overlay?.notification(notification.method, notification.params);
      } catch {
        // The overlay is cosmetic; the notification still reaches the server.
      }
      emit({ type: "notification", method: notification.method, params: notification.params });
    },
  });
  const overlay = supported ? makeElectronOverlay() : null;
  const router = new ComputerUseRouter(supervisor, emit, overlay ? { observer: overlay } : {});

  const shutdown = Effect.promise(() => router.shutdown()).pipe(
    Effect.ensuring(Effect.sync(() => overlay?.dispose())),
  );
  yield* Effect.addFinalizer(() => shutdown);

  return ComputerUseChannelHost.of({
    // Subscribes before announcing the status, so no event falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* PubSub.publish(outbox, router.statusEvent());
        runFork(Effect.promise(() => router.serverAttached()));
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
    handleCommandLine: (line) =>
      Effect.sync(() => {
        const command = decodeCommand(line);
        if (Option.isNone(command)) {
          runFork(logWarning("ignored invalid computer-use command"));
          return;
        }
        // Requests run concurrently; the helper serializes per app.
        runFork(Effect.promise(() => router.handle(command.value)));
      }),
    shutdown,
  });
});

export const layer = Layer.effect(ComputerUseChannelHost, make);

/** No helper: for backend tests that do not exercise computer use. */
export const layerTest = Layer.succeed(
  ComputerUseChannelHost,
  ComputerUseChannelHost.of({
    events: Stream.never,
    handleCommandLine: () => Effect.void,
    shutdown: Effect.void,
  }),
);
