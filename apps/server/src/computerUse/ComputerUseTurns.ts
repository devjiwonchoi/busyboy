/**
 * Per-turn computer-use state on the server: whether the helper session for a
 * turn has begun, whether the turn was stopped, the open approval cards, and
 * the answers given in the turn.
 * A turn here is an orchestration run. When the run ends, in-flight helper
 * requests for it are interrupted (the channel sends `cancel` for each) and the
 * helper gets `session.end`. A helper `stopped` notification (Esc or the user
 * taking over the app) stops the turn and interrupts its run, the same way the
 * web Stop button does.
 */
import {
  CommandId,
  ComputerUseError,
  ComputerUseStopReason,
  RunId,
  ThreadId,
  type ComputerUseAppRequestStatus,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as DesktopComputerUseChannel from "./DesktopComputerUseChannel.ts";

const SESSION_TIMEOUT_MS = 10_000;
/** How long a prewarm waits for the helper to start before giving up. */
const PREWARM_TIMEOUT_MS = 10_000;
/** How long the end of a turn waits for its in-flight requests to cancel. */
const DRAIN_TIMEOUT_MS = 1_000;

const decodeStopped = Schema.decodeUnknownOption(
  Schema.Struct({ turnId: Schema.String, reason: ComputerUseStopReason }),
);

/**
 * How many ended turns to remember. A call that races a turn's end (for
 * example, Stop pressed during `apps.resolve`) must fail rather than start
 * fresh state for a turn that is already over. Old entries drop first.
 */
const ENDED_TURNS_KEPT = 1_000;

export type TurnEnd =
  | { readonly type: "completed" }
  | { readonly type: "stopped"; readonly reason: ComputerUseStopReason };

export const STOPPED_HINT = "stop and tell the user; do not retry this turn";

export const stoppedError = (reason: ComputerUseStopReason) =>
  new ComputerUseError({
    code: "stopped",
    message: "computer use was stopped for this turn",
    hint: STOPPED_HINT,
    details: { reason },
    retryable: false,
  });

export const turnInactiveError = () =>
  new ComputerUseError({
    code: "turn_inactive",
    message: "this call is not tied to an active turn, or the turn has ended",
    retryable: false,
  });

const turnEndError = (end: TurnEnd) =>
  end.type === "completed" ? turnInactiveError() : stoppedError(end.reason);

/** The user's answers. `pending` and `cancelled` are not answers. */
const isAnswer = (status: ComputerUseAppRequestStatus) =>
  status !== "pending" && status !== "cancelled";

interface Card {
  readonly turnItemId: string;
  readonly bundleId: string;
  readonly answer: Deferred.Deferred<ComputerUseAppRequestStatus>;
  /** Records the card as cancelled in the thread. */
  readonly hide: Effect.Effect<void>;
  /** Calls still waiting for the answer. The card stays open while any remain. */
  waiters: number;
  /** False only when showing the card failed, so there is nothing to hide. */
  shown: boolean;
  /** Set once the card closes. */
  status: ComputerUseAppRequestStatus | undefined;
}

interface TurnState {
  readonly threadId: string;
  readonly turnId: string;
  readonly ended: Deferred.Deferred<TurnEnd>;
  stopped: ComputerUseStopReason | undefined;
  session: "none" | "beginning" | "begun";
  /** Lets only one call begin the session; the others wait for it. */
  readonly sessionLock: Semaphore.Semaphore;
  /** Open cards by turn item ID. */
  readonly cards: Map<string, Card>;
  /** The open card for each bundle ID, which concurrent calls join. */
  readonly openByApp: Map<string, string>;
  /** The latest answer for each bundle ID in this turn. */
  readonly answers: Map<string, ComputerUseAppRequestStatus>;
  /** One latch per running `whileActive` call, done when the call has finished. */
  readonly inflight: Set<Deferred.Deferred<void>>;
}

export interface NewCard<E> {
  readonly turnItemId: string;
  /** Records the pending card in the thread. */
  readonly show: Effect.Effect<void, E>;
  /** Records the card as cancelled. Runs when the last waiter leaves a cancelled card. */
  readonly hide: Effect.Effect<void>;
}

export type CardTicket =
  /** This app was already answered in this turn: no card. */
  | { readonly type: "answered"; readonly status: ComputerUseAppRequestStatus }
  | {
      readonly type: "waiting";
      readonly turnItemId: string;
      /** Resolves with the answer, or `cancelled`. */
      readonly answer: Effect.Effect<ComputerUseAppRequestStatus>;
      /** Must run when the call stops waiting. The last waiter to leave closes the card. */
      readonly leave: Effect.Effect<void>;
    };

export class ComputerUseTurns extends Context.Service<
  ComputerUseTurns,
  {
    /**
     * Fails pending calls of the turn with `stopped` and keeps later calls of
     * the turn failing. C4 calls this from helper `stopped` notifications.
     */
    readonly markStopped: (
      threadId: string,
      turnId: string,
      reason: ComputerUseStopReason,
    ) => Effect.Effect<void>;
    readonly stoppedReason: (
      threadId: string,
      turnId: string,
    ) => Effect.Effect<Option.Option<ComputerUseStopReason>>;
    /** Fails with `stopped` or `turn_inactive` if the turn was stopped or has ended. */
    readonly requireActive: (
      threadId: string,
      turnId: string,
    ) => Effect.Effect<void, ComputerUseError>;
    /** Sends `session.begin` once per turn, before its first state or action request. */
    readonly ensureSession: (
      threadId: string,
      turnId: string,
    ) => Effect.Effect<void, ComputerUseError>;
    /** Runs `effect` until the turn ends or is stopped, which interrupts it. */
    readonly whileActive: <A, E, R>(
      threadId: string,
      turnId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ComputerUseError, R>;
    /**
     * The answer already given for this app in this turn, or a place in the
     * open card for this app, or a new card shown with `newCard.show`.
     * Ending the turn resolves open cards as cancelled.
     */
    readonly card: <E>(
      threadId: string,
      turnId: string,
      bundleId: string,
      newCard: NewCard<E>,
    ) => Effect.Effect<CardTicket, E | ComputerUseError>;
    /** Closes only the card with this turn item ID, and remembers the answer for its app. */
    readonly closeCard: (
      threadId: string,
      turnId: string,
      turnItemId: string,
      bundleId: string,
      status: ComputerUseAppRequestStatus,
    ) => Effect.Effect<void>;
    /** Ends the turn: in-flight work is interrupted and the helper session ends. */
    readonly endTurn: (threadId: string, turnId: string, end: TurnEnd) => Effect.Effect<void>;
    readonly handleDomainEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /**
     * A helper `stopped` notification for a turn whose session has begun or
     * is beginning: stops the turn and interrupts its run. Unknown, ended, or
     * already stopped turns are ignored.
     */
    readonly handleNotification: (
      notification: DesktopComputerUseChannel.ComputerUseNotification,
    ) => Effect.Effect<void>;
  }
>()("t3/computerUse/ComputerUseTurns") {}

const keyOf = (threadId: string, turnId: string) => `${threadId}\u0000${turnId}`;

export const make = Effect.gen(function* () {
  const channel = yield* DesktopComputerUseChannel.DesktopComputerUseChannel;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  /** Background run interrupts live here, so they end with the service. */
  const scope = yield* Effect.scope;
  const turns = new Map<string, TurnState>();
  /** Ended turns, oldest first. */
  const endedTurns = new Map<string, TurnEnd>();

  const rememberEnded = (key: string, end: TurnEnd) => {
    endedTurns.delete(key);
    endedTurns.set(key, end);
    if (endedTurns.size > ENDED_TURNS_KEPT) {
      const oldest = endedTurns.keys().next().value;
      if (oldest !== undefined) endedTurns.delete(oldest);
    }
  };

  /** Ignores the stopped flag; callers that act must use `stateFor`. */
  const rawStateFor = (threadId: string, turnId: string) =>
    Effect.gen(function* () {
      const key = keyOf(threadId, turnId);
      const existing = turns.get(key);
      if (existing !== undefined) return existing;
      const state: TurnState = {
        threadId,
        turnId,
        ended: yield* Deferred.make<TurnEnd>(),
        stopped: undefined,
        session: "none",
        sessionLock: yield* Semaphore.make(1),
        cards: new Map(),
        openByApp: new Map(),
        answers: new Map(),
        inflight: new Set(),
      };
      turns.set(key, state);
      return state;
    });

  /** The live state of the turn, or the `stopped` / `turn_inactive` error. */
  const stateFor = (threadId: string, turnId: string) =>
    Effect.gen(function* () {
      const key = keyOf(threadId, turnId);
      const end = endedTurns.get(key);
      if (end !== undefined) return yield* turnEndError(end);
      const state = yield* rawStateFor(threadId, turnId);
      if (state.stopped !== undefined) return yield* stoppedError(state.stopped);
      return state;
    });

  const closeOpen = (state: TurnState, card: Card, status: ComputerUseAppRequestStatus) =>
    Effect.suspend(() => {
      if (card.status !== undefined) return Effect.void;
      card.status = status;
      state.cards.delete(card.turnItemId);
      if (state.openByApp.get(card.bundleId) === card.turnItemId) {
        state.openByApp.delete(card.bundleId);
      }
      if (isAnswer(status)) state.answers.set(card.bundleId, status);
      return Deferred.succeed(card.answer, status);
    });

  const cancelCards = (state: TurnState) =>
    Effect.forEach([...state.cards.values()], (card) => closeOpen(state, card, "cancelled"), {
      discard: true,
    });

  /** The last waiter closes a still-open card, and hides a cancelled one. */
  const leave = (state: TurnState, card: Card) =>
    Effect.suspend(() => {
      card.waiters -= 1;
      if (card.waiters > 0) return Effect.void;
      return closeOpen(state, card, "cancelled").pipe(
        Effect.andThen(
          Effect.suspend(() =>
            card.status === "cancelled" && card.shown ? card.hide : Effect.void,
          ),
        ),
      );
    });

  const waiting = (state: TurnState, card: Card): CardTicket => ({
    type: "waiting",
    turnItemId: card.turnItemId,
    answer: Deferred.await(card.answer),
    leave: leave(state, card),
  });

  const markStopped: ComputerUseTurns["Service"]["markStopped"] = (threadId, turnId, reason) =>
    Effect.gen(function* () {
      const key = keyOf(threadId, turnId);
      if (endedTurns.has(key)) return;
      const state = yield* rawStateFor(threadId, turnId);
      if (state.stopped !== undefined) return;
      state.stopped = reason;
      yield* cancelCards(state);
      yield* Deferred.succeed(state.ended, { type: "stopped", reason });
    });

  const stoppedReason: ComputerUseTurns["Service"]["stoppedReason"] = (threadId, turnId) =>
    Effect.sync(() => {
      const key = keyOf(threadId, turnId);
      const end = endedTurns.get(key);
      return Option.fromNullishOr(
        end === undefined
          ? turns.get(key)?.stopped
          : end.type === "stopped"
            ? end.reason
            : undefined,
      );
    });

  const requireActive: ComputerUseTurns["Service"]["requireActive"] = (threadId, turnId) =>
    Effect.asVoid(stateFor(threadId, turnId));

  const ensureSession: ComputerUseTurns["Service"]["ensureSession"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const state = yield* stateFor(threadId, turnId);
      yield* state.sessionLock.withPermits(1)(
        Effect.gen(function* () {
          if (state.session === "begun") return;
          state.session = "beginning";
          yield* channel
            .request("session.begin", { threadId, turnId }, { timeoutMs: SESSION_TIMEOUT_MS })
            .pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  // An interrupted begin may already have reached the helper, so
                  // keep it as "beginning": the turn's end then sends `session.end`.
                  state.session = Exit.isSuccess(exit)
                    ? "begun"
                    : Exit.hasInterrupts(exit)
                      ? "beginning"
                      : "none";
                }),
              ),
            );
        }),
      );
    });

  const whileActive: ComputerUseTurns["Service"]["whileActive"] = (threadId, turnId, effect) =>
    Effect.gen(function* () {
      const state = yield* stateFor(threadId, turnId);
      const finished = yield* Deferred.make<void>();
      state.inflight.add(finished);
      // The race interrupts the losing `effect` and waits for it, so the
      // channel has sent `cancel` by the time `finished` is done.
      return yield* Effect.raceFirst(
        effect,
        Deferred.await(state.ended).pipe(Effect.flatMap((end) => Effect.fail(turnEndError(end)))),
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            state.inflight.delete(finished);
            return Deferred.succeed(finished, undefined);
          }),
        ),
      );
    });

  const card: ComputerUseTurns["Service"]["card"] = (threadId, turnId, bundleId, newCard) =>
    Effect.gen(function* () {
      const state = yield* stateFor(threadId, turnId);
      const answered = state.answers.get(bundleId);
      if (answered !== undefined) return { type: "answered", status: answered } as const;
      const openId = state.openByApp.get(bundleId);
      const open = openId === undefined ? undefined : state.cards.get(openId);
      if (open !== undefined) {
        open.waiters += 1;
        return waiting(state, open);
      }
      const created: Card = {
        turnItemId: newCard.turnItemId,
        bundleId,
        answer: yield* Deferred.make<ComputerUseAppRequestStatus>(),
        hide: newCard.hide,
        waiters: 1,
        shown: true,
        status: undefined,
      };
      state.cards.set(created.turnItemId, created);
      state.openByApp.set(bundleId, created.turnItemId);
      yield* newCard.show.pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          // A failed show recorded nothing, so close the card for everyone.
          // An interrupted show may have recorded it, so only this call leaves.
          if (!Exit.hasInterrupts(exit)) {
            created.shown = false;
            return closeOpen(state, created, "cancelled").pipe(
              Effect.andThen(leave(state, created)),
            );
          }
          return leave(state, created);
        }),
      );
      return waiting(state, created);
    });

  const closeCard: ComputerUseTurns["Service"]["closeCard"] = (
    threadId,
    turnId,
    turnItemId,
    bundleId,
    status,
  ) =>
    Effect.suspend(() => {
      const state = turns.get(keyOf(threadId, turnId));
      if (state === undefined) return Effect.void;
      if (isAnswer(status)) state.answers.set(bundleId, status);
      const open = state.cards.get(turnItemId);
      return open === undefined ? Effect.void : closeOpen(state, open, status);
    });

  const endTurn: ComputerUseTurns["Service"]["endTurn"] = (threadId, turnId, end) =>
    Effect.gen(function* () {
      const key = keyOf(threadId, turnId);
      if (endedTurns.has(key)) return;
      const state = turns.get(key);
      // Recorded even without state, so a call still resolving its app fails.
      rememberEnded(
        key,
        state?.stopped === undefined ? end : { type: "stopped", reason: state.stopped },
      );
      if (state === undefined) return;
      turns.delete(key);
      // A begin that is in flight or was interrupted counts: the helper may
      // already have begun the session.
      const hadSession = state.session !== "none";
      yield* cancelCards(state);
      // Interrupts in-flight requests; the channel cancels each on the helper.
      // A stopped turn keeps its first reason: this does nothing then.
      const inflight = [...state.inflight];
      yield* Deferred.succeed(state.ended, end);
      // Send `session.end` only after every in-flight request has sent its `cancel`.
      yield* Effect.forEach(inflight, (finished) => Deferred.await(finished), {
        discard: true,
      }).pipe(Effect.timeoutOption(DRAIN_TIMEOUT_MS));
      if (hadSession) {
        yield* channel
          .request("session.end", { threadId, turnId }, { timeoutMs: SESSION_TIMEOUT_MS })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("computer-use session.end failed", { code: error.code }),
            ),
          );
      }
    });

  /**
   * The helper stops after ten idle minutes. A run that starts while it is
   * stopped starts it in the background, so the agent's first computer_* call
   * does not wait for the launch.
   */
  let prewarmInFlight = false;
  const prewarm = Effect.gen(function* () {
    if (prewarmInFlight || !channel.available || Option.isNone(serverSettings)) {
      return;
    }
    const enabled = yield* serverSettings.value.getSettings.pipe(
      Effect.map((settings) => settings.enableAgentComputerUse),
      Effect.orElseSucceed(() => false),
    );
    const status = yield* channel.status;
    if (
      !enabled ||
      status.state !== "stopped" ||
      status.reason === "unsupported_platform" ||
      prewarmInFlight
    ) {
      return;
    }
    // Keep starting/running updates from launching concurrent helper requests.
    prewarmInFlight = true;
    yield* channel.request("permissions.status", {}, { timeoutMs: PREWARM_TIMEOUT_MS }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("computer-use prewarm failed", { code: error.code }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          prewarmInFlight = false;
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const handleDomainEvent: ComputerUseTurns["Service"]["handleDomainEvent"] = (event) => {
    if (event.type !== "run.updated") return Effect.void;
    const run = event.payload;
    if (run.status === "starting" || run.status === "running") return prewarm;
    if (!ThreadManagementService.isTerminalRunStatus(run.status)) return Effect.void;
    return endTurn(
      event.threadId,
      run.id,
      run.status === "completed"
        ? { type: "completed" }
        : { type: "stopped", reason: "client_stop" },
    );
  };

  const handleNotification: ComputerUseTurns["Service"]["handleNotification"] = (notification) =>
    Effect.gen(function* () {
      if (notification.method !== "stopped") return;
      const params = decodeStopped(notification.params);
      if (Option.isNone(params)) return;
      const { turnId, reason } = params.value;
      // A locked screen is not a stop: the helper fails the in-flight call with
      // `screen_locked`, and the turn goes on after the user unlocks (spec 5.5).
      if (reason === "screen_locked") return;
      // A stop can arrive before the `session.begin` response does: the helper
      // may already be running the session.
      const state = [...turns.values()].find(
        (candidate) => candidate.turnId === turnId && candidate.session !== "none",
      );
      if (state === undefined || state.stopped !== undefined) return;
      yield* markStopped(state.threadId, turnId, reason);
      // `markStopped` already failed the in-flight calls, which sends their
      // `cancel`. Now stop the run with the same command as the web Stop
      // button, which holds queued messages so none starts a new run. When the
      // run ends, `endTurn` sends `session.end`.
      const interrupt = threads.dispatch({
        type: "run.interrupt",
        // The same id on retry, so a first try that did land is not applied twice.
        commandId: CommandId.make(`computer-use-stop:${state.threadId}:${turnId}`),
        threadId: ThreadId.make(state.threadId),
        runId: RunId.make(turnId),
        reason: `computer use stopped: ${reason}`,
        holdQueue: true,
      });
      // Runs in the background so a slow interrupt never delays stops for other turns.
      yield* interrupt.pipe(
        // Try once more before giving up: the user expects the turn to stop.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () => interrupt,
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("could not interrupt a turn after computer use stopped", { cause }),
        ),
        Effect.forkIn(scope),
      );
    });

  return ComputerUseTurns.of({
    markStopped,
    stoppedReason,
    requireActive,
    ensureSession,
    whileActive,
    card,
    closeCard,
    endTurn,
    handleDomainEvent,
    handleNotification,
  });
});

/** Ends helper sessions when their runs end, and stops turns on helper `stopped`. */
export const layer = Layer.effect(
  ComputerUseTurns,
  Effect.gen(function* () {
    const service = yield* make;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const channel = yield* DesktopComputerUseChannel.DesktopComputerUseChannel;
    yield* forkParked(
      Stream.runForEach(channel.notifications, service.handleNotification).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("computer-use notification stream failed", { cause }),
        ),
      ),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, service.handleDomainEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("computer-use turn event stream failed", { cause }),
        ),
      ),
    );
    return service;
  }),
);

/** Without the run event and notification streams, for tests. */
export const layerWithoutEvents = Layer.effect(ComputerUseTurns, make);
