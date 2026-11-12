/**
 * Moves an in-progress task lead between the user's Mac and a cloud sandbox.
 *
 * The Mac worktree is always the up-to-date copy of the lead's work, so a move
 * only stops the lead's turn, carries its claude transcripts over and flips
 * where its next turn runs. To the cloud, the next turn's sandbox copies the
 * worktree in; to the Mac, the sandbox is mirrored a last time and deleted.
 * Messages sent meanwhile wait and run at the new place. A failure puts the
 * task and thread back where they were.
 */
import {
  CommandId,
  type ExecutionLocation,
  MessageId,
  type OrchestrationV2ServerCommand,
  type ProjectTask,
  type ProjectTeamError,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import type { CloudLeadHooksShape } from "./CloudLeadService.ts";
import type { LeadHoldReason, LeadMoveGateShape } from "./LeadMoveGate.ts";

export class TaskMoveError extends Schema.TaggedError<TaskMoveError>()("TaskMoveError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** What pausing and resuming a lead's turns needs. */
export interface LeadControlDeps {
  readonly threads: Pick<ThreadManagementServiceShape, "dispatch" | "getThreadShell">;
  readonly gate: LeadMoveGateShape;
  readonly newKey: (prefix: string) => Effect.Effect<string>;
  /** How often to look whether the stopped turn has ended. */
  readonly pollEvery?: number;
  readonly stopTimeoutMs?: number;
}

export interface TaskMoverDeps extends LeadControlDeps {
  readonly threads: Pick<
    ThreadManagementServiceShape,
    "dispatch" | "getThreadShell" | "getThreadRecords"
  >;
  readonly cloudLead: CloudLeadHooksShape;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Writes move_target (and location); none when expectedMoveTarget no longer matches. */
  readonly setMove: (input: {
    readonly task: ProjectTask;
    readonly moveTarget: ExecutionLocation | null;
    readonly location?: ExecutionLocation;
    readonly expectedMoveTarget?: ExecutionLocation | null;
  }) => Effect.Effect<Option.Option<ProjectTask>, ProjectTeamError>;
  readonly note: (task: ProjectTask, body: string) => Effect.Effect<unknown, ProjectTeamError>;
  readonly publish: (task: ProjectTask) => Effect.Effect<void>;
  readonly isFinished: (task: ProjectTask) => boolean;
  /**
   * The lead's children that work in its checkout (and so in its sandbox);
   * they move with it. The caller refuses a move while one of them is working.
   */
  readonly sharedChildren?: (
    lead: ThreadId,
    worktreePath: string,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectTeamError>;
}

const PLACE: Record<ExecutionLocation, string> = { local: "로컬", cloud: "클라우드" };

export const moveNotice = (from: ExecutionLocation, to: ExecutionLocation) =>
  `[옮김] ${PLACE[from]}→${PLACE[to]}`;

const fail = (detail: string) => Effect.fail(new TaskMoveError({ detail }));

const detailOf = (cause: unknown): string =>
  cause instanceof Error || (typeof cause === "object" && cause !== null && "message" in cause)
    ? String((cause as { message: unknown }).message)
    : String(cause);

/**
 * Whether a lead can move at all: it needs its own worktree and a Claude session.
 * Returns why not, or what the move carries.
 */
export const inspectMovableLead = (
  deps: Pick<TaskMoverDeps, "threads" | "providers">,
  lead: ThreadId,
) =>
  Effect.gen(function* () {
    // A failed read is not a lead that cannot move; it fails the caller instead.
    const shell = yield* deps.threads
      .getThreadShell(lead)
      .pipe(Effect.mapError((cause) => new TaskMoveError({ detail: detailOf(cause) })));
    if (shell === null || shell.worktreePath === null) {
      return { movable: false as const, reason: "리드에 자기 워크트리가 없어 옮길 수 없어요." };
    }
    const { providerThreads } = yield* deps.threads
      .getThreadRecords(lead, ["providerThreads"])
      .pipe(Effect.orElseSucceed(() => ({ providerThreads: [] })));
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === shell.activeProviderThreadId,
    );
    const driver =
      providerThread?.driver ??
      (yield* deps.providers).find((provider) => provider.instanceId === shell.providerInstanceId)
        ?.driver;
    if (driver !== "claudeAgent") {
      return {
        movable: false as const,
        reason: "Claude 리드만 로컬과 클라우드 사이를 옮길 수 있어요.",
      };
    }
    return {
      movable: true as const,
      worktreePath: shell.worktreePath,
      sessionId: providerThread?.nativeThreadRef?.nativeId ?? null,
    };
  });

/** Moves `task`'s lead to `to`; returns the task as it stands after the move. */
export const moveTaskLead = (deps: TaskMoverDeps, task: ProjectTask, to: ExecutionLocation) =>
  Effect.gen(function* () {
    const from = task.location ?? "local";
    const lead = task.leadThreadId;
    if (deps.isFinished(task))
      return yield* fail(`#${task.number}은 끝난 태스크라 옮길 수 없어요.`);
    if (lead === null) return yield* fail("리드가 아직 시작하지 않아 옮길 수 없어요.");
    if (task.moveTarget != null) return yield* fail("이미 옮기는 중이에요.");
    if (from === to) return yield* fail(`이미 ${PLACE[to]}에서 실행 중이에요.`);
    const inspected = yield* inspectMovableLead(deps, lead);
    if (!inspected.movable) return yield* fail(inspected.reason);
    const { worktreePath, sessionId } = inspected;

    const claimed = yield* deps
      .setMove({ task, moveTarget: to, expectedMoveTarget: null })
      .pipe(Effect.mapError((cause) => new TaskMoveError({ detail: detailOf(cause) })));
    if (Option.isNone(claimed)) return yield* fail("이미 옮기는 중이에요.");
    const children =
      deps.sharedChildren === undefined
        ? []
        : yield* deps
            .sharedChildren(lead, worktreePath)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadId> => []));
    // The children on the lead's checkout wait out the move too: a turn of theirs
    // at the old place would edit the checkout the lead has left.
    deps.gate.hold(lead, "move");
    for (const child of children) deps.gate.hold(child, "move");
    yield* deps.publish(claimed.value);

    const {
      dispatch,
      tellLead,
      resumeQueue: resumeLead,
      stopTurn,
    } = leadControl(deps, lead, "move");
    const resumeQueue = Effect.gen(function* () {
      yield* resumeLead;
      for (const child of children) yield* leadControl(deps, child, "move").resumeQueue;
    });
    const setLocation = (threadId: ThreadId, location: ExecutionLocation) =>
      dispatch(
        (key) => ({
          type: "thread.metadata.update",
          commandId: CommandId.make(key),
          threadId,
          location,
        }),
        "location",
      );
    // The lead's children share its checkout, so their next turns go where it went.
    const setThreadLocation = (location: ExecutionLocation) =>
      Effect.forEach([lead, ...children], (threadId) => setLocation(threadId, location), {
        discard: true,
      });
    const state = { interrupted: false, transcriptMissing: false };

    const steps = Effect.gen(function* () {
      // 1. Stop the lead's turn where it runs now; later messages wait.
      // A child that started a turn before it was held must finish first.
      for (const child of children) {
        const shell = yield* deps.threads
          .getThreadShell(child)
          .pipe(Effect.orElseSucceed(() => null));
        if (
          shell !== null &&
          (shell.activeRunId !== null || shell.pendingRuntimeRequest !== null)
        ) {
          return yield* fail(
            `리드가 맡긴 작업(${shell.title})이 아직 진행 중이라 옮길 수 없어요. 끝난 뒤 다시 옮겨 주세요.`,
          );
        }
      }
      state.interrupted = yield* stopTurn;
      // 2. Carry the transcripts and flip the place.
      if (to === "cloud") {
        yield* deps.cloudLead
          .importTranscripts({ threadId: lead, worktreePath })
          .pipe(Effect.mapError((error) => new TaskMoveError({ detail: error.detail })));
      } else {
        // By worktree: the sandbox is the lead's checkout, whichever thread last started it.
        yield* deps.cloudLead
          .syncToMac(worktreePath)
          .pipe(Effect.mapError((error) => new TaskMoveError({ detail: error.detail })));
        yield* deps.cloudLead.release(worktreePath);
        yield* deps.cloudLead
          .exportTranscripts({ threadId: lead, worktreePath })
          .pipe(Effect.mapError((error) => new TaskMoveError({ detail: error.detail })));
      }
      yield* setThreadLocation(to);
      yield* deps
        .setMove({ task, moveTarget: to, location: to })
        .pipe(Effect.mapError((cause) => new TaskMoveError({ detail: detailOf(cause) })));
      // 3. Resume the same claude session there, or start fresh from a summary.
      if (sessionId !== null) {
        const present = yield* deps.cloudLead
          .hasTranscript({ threadId: lead, worktreePath, sessionId, location: to })
          .pipe(Effect.orElseSucceed(() => false));
        if (!present) {
          deps.gate.requestFreshSession(lead);
          state.transcriptMissing = true;
        }
      }
    });

    const result = yield* Effect.exit(steps);
    if (Exit.isSuccess(result)) {
      // 4. Tell the lead, then let the waiting messages run at the new place.
      yield* tellLead(moveNotice(from, to)).pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not tell a moved lead", { lead, detail: error.detail }),
        ),
      );
      yield* resumeQueue;
      // 5. The move is done.
      const done = yield* deps
        .setMove({ task, moveTarget: null })
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectTask>()));
      yield* deps
        .note(
          task,
          `리드를 ${PLACE[from]}에서 ${PLACE[to]}로 옮겼어요.${
            state.transcriptMissing
              ? " 대화 기록을 옮기지 못해 다음 턴은 지금까지의 요약으로 새 세션에서 시작해요."
              : ""
          }`,
        )
        .pipe(Effect.ignore);
      const moved = Option.getOrElse(done, () => ({ ...task, location: to, moveTarget: null }));
      yield* deps.publish(moved);
      return moved;
    }

    // Put everything back where it was.
    const reason = Cause.squash(result.cause);
    const detail = detailOf(reason);
    yield* setThreadLocation(from).pipe(Effect.ignore);
    yield* deps.setMove({ task, moveTarget: null, location: from }).pipe(Effect.ignore);
    // The session stays where it was, so the next turn resumes it as before.
    deps.gate.takeFreshSession(lead);
    if (state.interrupted) {
      yield* tellLead(`[옮김 실패] ${PLACE[from]}에서 그대로 이어가요.`).pipe(Effect.ignore);
    }
    yield* resumeQueue;
    yield* deps
      .note(task, `리드를 ${PLACE[to]}로 옮기지 못해 ${PLACE[from]}에 그대로 뒀어요: ${detail}`)
      .pipe(Effect.ignore);
    yield* deps.publish({ ...task, location: from, moveTarget: null });
    return yield* fail(`리드를 ${PLACE[to]}로 옮기지 못했어요: ${detail}`);
  }).pipe(Effect.uninterruptible);

/** Stopping, telling and resuming one lead; a move and a sandbox rotation share these. */
export const leadControl = (deps: LeadControlDeps, lead: ThreadId, reason: LeadHoldReason) => {
  const dispatch = (command: (key: string) => OrchestrationV2ServerCommand, prefix: string) =>
    Effect.flatMap(deps.newKey(`task-move:${prefix}`), (key) =>
      deps.threads.dispatch(command(key)),
    ).pipe(Effect.mapError((cause) => new TaskMoveError({ detail: detailOf(cause) })));

  const tellLead = (text: string) =>
    dispatch(
      (key) => ({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId: lead,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      }),
      "notice",
    );

  /** Ends this hold; the waiting messages run once no other hold is left. */
  const resumeQueue = Effect.gen(function* () {
    deps.gate.release(lead, reason);
    if (deps.gate.isHeld(lead)) return;
    yield* dispatch(
      (key) => ({ type: "queue.resume", commandId: CommandId.make(key), threadId: lead }),
      "resume",
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not resume a lead's held queue", { lead, detail: error.detail }),
      ),
    );
  });

  /** Interrupts the running turn, holding the queue, and waits for it to end. True when one ran. */
  const stopTurn = Effect.gen(function* () {
    const shell = yield* deps.threads.getThreadShell(lead).pipe(Effect.orElseSucceed(() => null));
    const runId = shell?.activeRunId ?? null;
    if (runId === null) return false;
    yield* dispatch(
      (key) => ({
        type: "run.interrupt",
        commandId: CommandId.make(key),
        threadId: lead,
        runId,
        reason:
          reason === "memory" ? "Pausing while the Mac is short on memory" : "Moving the task lead",
        holdQueue: true,
      }),
      "interrupt",
    );
    const pollEvery = deps.pollEvery ?? 200;
    const deadline = (deps.stopTimeoutMs ?? 120_000) / pollEvery;
    for (let attempt = 0; ; attempt += 1) {
      const current = yield* deps.threads
        .getThreadShell(lead)
        .pipe(Effect.orElseSucceed(() => null));
      if (current === null || current.activeRunId === null) return true;
      if (attempt >= deadline) return yield* fail("리드의 턴이 멈추지 않았어요.");
      yield* Effect.sleep(pollEvery);
    }
  });

  return { dispatch, tellLead, resumeQueue, stopTurn };
};
