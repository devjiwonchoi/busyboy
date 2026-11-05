import {
  BrowserRequestError,
  CommandId,
  type BrowserRequestAnswerInput,
  type BrowserRequestHistoryVisit,
  type OrchestrationV2BrowserRequestStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Answers to browser request cards (sign-in and history access). The card
 * records only the outcome; shared history waits here, in memory, for the one
 * tool call that asked, which takes it once.
 */
export class BrowserRequests extends Context.Service<
  BrowserRequests,
  {
    readonly answer: (input: BrowserRequestAnswerInput) => Effect.Effect<void, BrowserRequestError>;
    /** The visits shared for this card, removed as they are read. */
    readonly takeHistory: (
      turnItemId: string,
    ) => Effect.Effect<Option.Option<ReadonlyArray<BrowserRequestHistoryVisit>>>;
  }
>()("t3/browserRequests/BrowserRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const sharedHistory = new Map<string, ReadonlyArray<BrowserRequestHistoryVisit>>();

  const answer: BrowserRequests["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "browser_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["browser_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new BrowserRequestError({ reason: "load_failed", cause })),
        );
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "browser_request" || item.runId === null || item.nodeId === null) {
        return yield* new BrowserRequestError({ reason: "not_found" });
      }
      if (item.browserStatus !== "pending") {
        return yield* new BrowserRequestError({ reason: "already_answered" });
      }
      if (item.requestKind !== input.answer.type) {
        return yield* new BrowserRequestError({ reason: "wrong_kind" });
      }
      const status: OrchestrationV2BrowserRequestStatus =
        input.answer.type === "sign_in"
          ? input.answer.outcome
          : input.answer.decision === "allow"
            ? "allowed"
            : "declined";
      // Kept before the record, so the waiting call finds it as soon as the card says allowed.
      if (input.answer.type === "history" && input.answer.decision === "allow") {
        sharedHistory.set(item.id, input.answer.visits);
      }
      yield* threadManagement
        .dispatch({
          type: "browser_request.record",
          commandId: CommandId.make(`browser-request:${item.id}:${status}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          requestKind: item.requestKind,
          reason: item.reason,
          ...(item.origin === undefined ? {} : { origin: item.origin }),
          ...(item.tabId === undefined ? {} : { tabId: item.tabId }),
          ...(item.query === undefined ? {} : { query: item.query }),
          ...(item.historySince === undefined ? {} : { historySince: item.historySince }),
          ...(item.historyLimit === undefined ? {} : { historyLimit: item.historyLimit }),
          ...(item.autoApprove === undefined ? {} : { autoApprove: item.autoApprove }),
          browserStatus: status,
        })
        .pipe(
          Effect.mapError((cause) => new BrowserRequestError({ reason: "record_failed", cause })),
          Effect.tapError(() => Effect.sync(() => sharedHistory.delete(item.id))),
        );
    }).pipe(Effect.withSpan("BrowserRequests.answer"));

  return BrowserRequests.of({
    answer,
    takeHistory: (turnItemId) =>
      Effect.sync(() => {
        const visits = sharedHistory.get(turnItemId);
        sharedHistory.delete(turnItemId);
        return Option.fromNullishOr(visits);
      }),
  });
});

export const layer = Layer.effect(BrowserRequests, make);
