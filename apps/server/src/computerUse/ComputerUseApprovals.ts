/**
 * Per-app approval for computer use. The first time an agent's run touches an
 * app, the thread shows a card and the agent waits for the user's answer:
 * this run only, this thread, every thread ("always", kept in settings), or
 * deny. Answers live here in memory, except "always", so a server restart
 * asks again for thread grants.
 */
import {
  CommandId,
  ComputerUseApprovalError,
  type ComputerUseApprovalAnswerInput,
  type ComputerUseApprovalDecision,
  ComputerUseError,
  type OrchestrationV2ComputerUseApprovalStatus,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface ComputerUseApprovalRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly appName: string;
  readonly bundleId: string;
}

export class ComputerUseApprovals extends Context.Service<
  ComputerUseApprovals,
  {
    /** Succeeds once the app is approved for this call; asks the user if it is not yet. */
    readonly require: (
      request: ComputerUseApprovalRequest,
    ) => Effect.Effect<void, ComputerUseError>;
    readonly answer: (
      input: ComputerUseApprovalAnswerInput,
    ) => Effect.Effect<void, ComputerUseApprovalError>;
  }
>()("t3/computerUse/ComputerUseApprovals") {}

const POLL_INTERVAL = Duration.millis(500);
// Long enough for a user who is reading the card, short enough that an agent
// does not hang on a card nobody is looking at.
const DEFAULT_WAIT = Duration.minutes(5);

const STATUS_FOR_DECISION: Record<
  ComputerUseApprovalDecision,
  OrchestrationV2ComputerUseApprovalStatus
> = {
  allow_once: "allowed_once",
  allow_thread: "allowed_thread",
  allow_always: "allowed_always",
  deny: "denied",
};

const idPart = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/** One card per app per run, so parallel calls for the same app share it. */
export const approvalTurnItemId = (threadId: ThreadId, runId: RunId, bundleId: string) =>
  TurnItemId.make(
    `turn-item:computer-use-approval:${idPart(threadId)}:${idPart(runId)}:${idPart(bundleId.toLowerCase())}`,
  );

const fail = (code: "app_denied" | "approval_unavailable", message: string) =>
  new ComputerUseError({ code, message });

const sameApp = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const make = (options?: { readonly wait?: Duration.Duration }) =>
  Effect.gen(function* () {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const wait = options?.wait ?? DEFAULT_WAIT;

    // threadId -> bundle IDs allowed for the whole thread.
    const threadGrants = yield* Ref.make(new Map<string, ReadonlySet<string>>());
    // runId -> bundle ID -> the run's answer.
    const runAnswers = yield* Ref.make(
      new Map<string, ReadonlyMap<string, "allowed" | "denied">>(),
    );

    const rememberRun = (runId: RunId, bundleId: string, answer: "allowed" | "denied") =>
      Ref.update(runAnswers, (runs) => {
        const next = new Map(runs);
        next.set(runId, new Map(runs.get(runId) ?? []).set(bundleId.toLowerCase(), answer));
        return next;
      });

    const rememberThread = (threadId: ThreadId, bundleId: string) =>
      Ref.update(threadGrants, (grants) => {
        const next = new Map(grants);
        next.set(threadId, new Set([...(grants.get(threadId) ?? []), bundleId.toLowerCase()]));
        return next;
      });

    const alwaysAllowed = (bundleId: string) =>
      settings.getSettings.pipe(
        Effect.map((current) => current.computerUseAllowedApps.some((id) => sameApp(id, bundleId))),
        Effect.orElseSucceed(() => false),
      );

    const loadCard = (threadId: ThreadId) =>
      threadManagement.getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["computer_use_approval"],
        messageRoles: [],
      });

    const applyStatus = (
      request: ComputerUseApprovalRequest,
      runId: RunId,
      status: OrchestrationV2ComputerUseApprovalStatus,
    ): Effect.Effect<void, ComputerUseError> => {
      switch (status) {
        case "allowed_once":
        case "allowed_always":
          return rememberRun(runId, request.bundleId, "allowed");
        case "allowed_thread":
          return rememberThread(request.threadId, request.bundleId);
        case "denied":
          return rememberRun(runId, request.bundleId, "denied").pipe(
            Effect.andThen(
              Effect.fail(
                fail(
                  "app_denied",
                  `The user did not allow computer use with ${request.appName}. Do not retry it in this turn; ask the user how to proceed.`,
                ),
              ),
            ),
          );
        case "pending":
        case "cancelled":
          return Effect.fail(
            fail(
              "approval_unavailable",
              `The user did not answer the request to use ${request.appName}.`,
            ),
          );
      }
    };

    const require: ComputerUseApprovals["Service"]["require"] = (request) =>
      Effect.gen(function* () {
        if (yield* alwaysAllowed(request.bundleId)) return;
        const threads = yield* Ref.get(threadGrants);
        if (threads.get(request.threadId)?.has(request.bundleId.toLowerCase()) === true) return;

        const unavailable = (message: string) => fail("approval_unavailable", message);
        const records = yield* loadCard(request.threadId).pipe(
          Effect.mapError(() => unavailable("Could not load the thread to ask for approval.")),
        );
        const run = ThreadManagementService.latestActiveRun(records);
        if (
          run === undefined ||
          run.rootNodeId === null ||
          run.providerInstanceId !== request.providerInstanceId
        ) {
          return yield* unavailable(
            "Computer use needs the user's approval, which requires an active turn of this agent.",
          );
        }
        const earlier = (yield* Ref.get(runAnswers))
          .get(run.id)
          ?.get(request.bundleId.toLowerCase());
        if (earlier === "allowed") return;
        if (earlier === "denied") return yield* applyStatus(request, run.id, "denied");

        const runId = run.id;
        const nodeId = run.rootNodeId;
        const turnItemId = approvalTurnItemId(request.threadId, runId, request.bundleId);
        const record = (approvalStatus: "pending" | "cancelled") =>
          threadManagement
            .dispatch({
              type: "computer_use_approval.record",
              commandId: CommandId.make(`computer-use-approval:${turnItemId}:${approvalStatus}`),
              threadId: request.threadId,
              runId,
              nodeId,
              turnItemId,
              appName: request.appName,
              bundleId: request.bundleId,
              approvalStatus,
            })
            .pipe(Effect.mapError(() => unavailable("Could not show the approval request.")));

        yield* record("pending");
        // The card must not outlive the wait: a timeout, failure or abort closes it.
        const closeCard = record("cancelled").pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close a computer-use approval card", {
              error: error.message,
            }),
          ),
        );

        const readStatus = loadCard(request.threadId).pipe(
          Effect.mapError(() => unavailable("Could not read the approval answer.")),
          Effect.map((projection) => {
            const card = projection.turnItems.find((item) => item.id === turnItemId);
            const cardRun = projection.runs.find((candidate) => candidate.id === runId);
            const status = card?.type === "computer_use_approval" ? card.approvalStatus : undefined;
            const runEnded =
              cardRun === undefined || ThreadManagementService.isTerminalRunStatus(cardRun.status);
            return { status, runEnded };
          }),
        );

        const answered = yield* Effect.gen(function* () {
          while (true) {
            const { status, runEnded } = yield* readStatus;
            if (status !== undefined && status !== "pending") return status;
            if (runEnded) {
              yield* closeCard;
              return "cancelled" as const;
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
        }).pipe(
          Effect.timeoutOption(wait),
          Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : closeCard)),
        );

        const status = yield* Option.match(answered, {
          onSome: Effect.succeed,
          // The user may have answered just as the wait ran out.
          onNone: () =>
            closeCard.pipe(
              Effect.andThen(readStatus),
              Effect.map(({ status: late }) => late ?? "cancelled"),
            ),
        });
        yield* applyStatus(request, runId, status);
      }).pipe(Effect.withSpan("ComputerUseApprovals.require"));

    const answer: ComputerUseApprovals["Service"]["answer"] = (input) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.thread_id": input.threadId,
          "computer_use.decision": input.decision,
        });
        const records = yield* loadCard(input.threadId).pipe(
          Effect.mapError(
            (cause) => new ComputerUseApprovalError({ reason: "load_failed", cause }),
          ),
        );
        const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
        if (item?.type !== "computer_use_approval" || item.runId === null || item.nodeId === null) {
          return yield* new ComputerUseApprovalError({ reason: "not_found" });
        }
        if (item.approvalStatus !== "pending") {
          return yield* new ComputerUseApprovalError({ reason: "already_answered" });
        }
        const run = records.runs.find((candidate) => candidate.id === item.runId);
        if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
          return yield* new ComputerUseApprovalError({ reason: "agent_stopped" });
        }
        const approvalStatus = STATUS_FOR_DECISION[input.decision];
        yield* threadManagement
          .dispatch({
            type: "computer_use_approval.record",
            commandId: CommandId.make(`computer-use-approval:${item.id}:${approvalStatus}`),
            threadId: input.threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            turnItemId: item.id,
            appName: item.appName,
            bundleId: item.bundleId,
            approvalStatus,
          })
          .pipe(
            Effect.mapError(
              (cause) => new ComputerUseApprovalError({ reason: "record_failed", cause }),
            ),
          );
        // The agent's wait may have closed the card first; then nothing was granted.
        const recorded = yield* loadCard(input.threadId).pipe(
          Effect.mapError(
            (cause) => new ComputerUseApprovalError({ reason: "record_failed", cause }),
          ),
        );
        const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
        if (card?.type !== "computer_use_approval" || card.approvalStatus !== approvalStatus) {
          return yield* new ComputerUseApprovalError({ reason: "agent_stopped" });
        }
        if (input.decision === "allow_always") {
          const current = yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) => new ComputerUseApprovalError({ reason: "save_failed", cause }),
            ),
          );
          if (!current.computerUseAllowedApps.some((id) => sameApp(id, item.bundleId))) {
            yield* settings
              .updateSettings({
                computerUseAllowedApps: [...current.computerUseAllowedApps, item.bundleId],
              })
              .pipe(
                Effect.mapError(
                  (cause) => new ComputerUseApprovalError({ reason: "save_failed", cause }),
                ),
              );
          }
        }
      }).pipe(Effect.withSpan("ComputerUseApprovals.answer"));

    return ComputerUseApprovals.of({ require, answer });
  });

export const layer = Layer.effect(ComputerUseApprovals, make());
