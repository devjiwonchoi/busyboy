// @effect-diagnostics nodeBuiltinImport:off - A random request key when the caller gives none.
import {
  CommandId,
  OrchestratorMcpFailure,
  TurnItemId,
  type BrowserRequestHistoryVisit,
  type OrchestrationV2BrowserRequestStatus,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";

import * as BrowserRequests from "../browserRequests/BrowserRequests.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

export type BrowserActionRequest =
  | {
      readonly kind: "sign_in";
      readonly origin: string;
      readonly tabId: string;
      readonly reason: string;
      readonly timeoutMs?: number | undefined;
      readonly clientRequestId?: string | undefined;
    }
  | {
      readonly kind: "history";
      readonly reason: string;
      /** The tab whose profile's history to read; the default profile when absent. */
      readonly tabId?: string | undefined;
      readonly query?: string | undefined;
      readonly since?: number | undefined;
      readonly limit: number;
      readonly autoApprove: boolean;
      readonly timeoutMs?: number | undefined;
      readonly clientRequestId?: string | undefined;
    };

export interface BrowserActionResult {
  readonly status: OrchestrationV2BrowserRequestStatus | "timed_out";
  readonly visits?: ReadonlyArray<BrowserRequestHistoryVisit>;
}

/** The person may be away from the desk; five minutes, like other approval cards' order of magnitude. */
export const BROWSER_REQUEST_DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const BROWSER_REQUEST_MAX_TIMEOUT_MS = 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stablePart = (value: string) => encodeURIComponent(value);

/**
 * Shows a sign-in or history card in the caller's thread and waits for the
 * person, like request_secret. Only an outcome comes back, plus visits the
 * person chose to share. The card is closed if the wait ends any other way.
 */
export const requestBrowserAction = Effect.fn("BrowserRequestCards.requestBrowserAction")(
  function* (scope: McpThreadInvocationScope, input: BrowserActionRequest) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    // Present wherever the server runs; absent only in narrow test hosts.
    const browserRequests = Option.getOrUndefined(
      yield* Effect.serviceOption(BrowserRequests.BrowserRequests),
    );
    const threadId = scope.thread.threadId;
    const parent = yield* threadManagement
      .getThreadRecords(threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
      .pipe(
        Effect.mapError((error) => failure(`Unable to read this thread: ${errorMessage(error)}`)),
      );
    const run = ThreadManagementService.latestActiveRun(parent);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== scope.thread.providerInstanceId
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: "Asking the user requires an active run owned by this MCP provider session.",
      });
    }
    const runId = run.id;
    const nodeId = run.rootNodeId;
    const key = input.clientRequestId ?? NodeCrypto.randomUUID();
    const turnItemId = TurnItemId.make(
      `turn-item:browser-request:${stablePart(threadId)}:${stablePart(key)}`,
    );
    const record = (browserStatus: "pending" | "cancelled") =>
      threadManagement
        .dispatch({
          type: "browser_request.record",
          commandId: CommandId.make(
            [
              "command",
              "mcp",
              stablePart(scope.requestNamespace),
              `browser-${input.kind}-${browserStatus}`,
              stablePart(key),
            ].join(":"),
          ),
          threadId,
          runId,
          nodeId,
          turnItemId,
          requestKind: input.kind,
          reason: input.reason,
          ...(input.kind === "sign_in"
            ? { origin: input.origin, tabId: input.tabId }
            : {
                ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
                ...(input.query === undefined ? {} : { query: input.query }),
                ...(input.since === undefined ? {} : { historySince: input.since }),
                historyLimit: input.limit,
                autoApprove: input.autoApprove,
              }),
          browserStatus,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(`Could not record the browser request: ${errorMessage(error)}`),
          ),
        );
    yield* record("pending");
    const closeCard = record("cancelled").pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not close a browser request card", { error: error.message }),
      ),
    );
    const readRecords = threadManagement
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["browser_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((error) =>
          failure(`Unable to read the browser request: ${errorMessage(error)}`),
        ),
      );
    const answered = yield* Effect.gen(function* () {
      while (true) {
        const projection = yield* readRecords;
        const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
        if (item?.type === "browser_request" && item.browserStatus !== "pending") {
          return item.browserStatus;
        }
        const current = projection.runs.find((candidate) => candidate.id === runId);
        if (current === undefined || ThreadManagementService.isTerminalRunStatus(current.status)) {
          yield* record("cancelled");
          return "cancelled" as const;
        }
        yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(
        Duration.millis(
          Math.min(
            input.timeoutMs ?? BROWSER_REQUEST_DEFAULT_TIMEOUT_MS,
            BROWSER_REQUEST_MAX_TIMEOUT_MS,
          ),
        ),
      ),
      // A turn interrupted mid-wait withdraws the card.
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
    );
    let status: OrchestrationV2BrowserRequestStatus | "timed_out";
    if (Option.isSome(answered)) {
      status = answered.value;
    } else {
      yield* closeCard;
      // An answer that landed just as the wait ran out still counts.
      const late = yield* readRecords.pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          return item?.type === "browser_request" &&
            item.browserStatus !== "pending" &&
            item.browserStatus !== "cancelled"
            ? item.browserStatus
            : undefined;
        }),
        Effect.orElseSucceed(() => undefined),
      );
      status = late ?? "timed_out";
    }
    const shared = browserRequests
      ? yield* browserRequests.takeHistory(turnItemId)
      : Option.none<ReadonlyArray<BrowserRequestHistoryVisit>>();
    const result: BrowserActionResult =
      status === "allowed" ? { status, visits: Option.getOrElse(shared, () => []) } : { status };
    return result;
  },
);
