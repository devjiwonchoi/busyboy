import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

/** One visit shared with an agent. Never includes password-manager data. */
export const BrowserRequestHistoryVisit = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  visitedAt: Schema.Number,
  source: Schema.Literals(["user", "agent"]),
});
export type BrowserRequestHistoryVisit = typeof BrowserRequestHistoryVisit.Type;

export const BROWSER_REQUEST_HISTORY_MAX_VISITS = 50;

export const BrowserSignInOutcome = Schema.Literals([
  "submitted",
  "submitted_unconfirmed",
  "filled",
  "declined",
  "page_left_origin",
  "no_login_form",
  "unavailable",
]);
export type BrowserSignInOutcome = typeof BrowserSignInOutcome.Type;

/**
 * The desktop app answers a browser request card. A sign-in answer carries
 * only the outcome; the login itself never leaves the desktop app.
 */
export const BrowserRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("sign_in"), outcome: BrowserSignInOutcome }),
    Schema.Struct({
      type: Schema.Literal("history"),
      decision: Schema.Literal("allow"),
      visits: Schema.Array(BrowserRequestHistoryVisit).check(
        Schema.isMaxLength(BROWSER_REQUEST_HISTORY_MAX_VISITS),
      ),
    }),
    Schema.Struct({ type: Schema.Literal("history"), decision: Schema.Literal("deny") }),
  ]),
});
export type BrowserRequestAnswerInput = typeof BrowserRequestAnswerInput.Type;

const BROWSER_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the browser request.",
  not_found: "This browser request no longer exists.",
  already_answered: "This browser request was already answered.",
  wrong_kind: "That answer doesn't match this browser request.",
  record_failed: "Could not update the browser request.",
} as const;

export const BrowserRequestFailureReason = Schema.Literals(
  Object.keys(BROWSER_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof BROWSER_REQUEST_FAILURE_MESSAGES
  >,
);
export type BrowserRequestFailureReason = typeof BrowserRequestFailureReason.Type;

export class BrowserRequestError extends Schema.TaggedError<BrowserRequestError>()(
  "BrowserRequestError",
  {
    reason: BrowserRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return BROWSER_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
