import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

/**
 * The user's answer to a computer-use app approval card. `allow_once` lasts
 * for the agent's current turn, `allow_thread` for the thread, and
 * `allow_always` for every thread until the user removes the app in Settings.
 */
export const ComputerUseApprovalDecision = Schema.Literals([
  "allow_once",
  "allow_thread",
  "allow_always",
  "deny",
]);
export type ComputerUseApprovalDecision = typeof ComputerUseApprovalDecision.Type;

export const ComputerUseApprovalAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  decision: ComputerUseApprovalDecision,
});
export type ComputerUseApprovalAnswerInput = typeof ComputerUseApprovalAnswerInput.Type;

const COMPUTER_USE_APPROVAL_FAILURE_MESSAGES = {
  load_failed: "Could not load the approval request.",
  not_found: "This approval request no longer exists.",
  already_answered: "This approval request was already answered.",
  agent_stopped: "The agent that asked has stopped.",
  save_failed: "Could not save the app to the always-allowed list.",
  record_failed: "Could not record the answer.",
} as const;

export const ComputerUseApprovalFailureReason = Schema.Literals(
  Object.keys(COMPUTER_USE_APPROVAL_FAILURE_MESSAGES) as Array<
    keyof typeof COMPUTER_USE_APPROVAL_FAILURE_MESSAGES
  >,
);
export type ComputerUseApprovalFailureReason = typeof ComputerUseApprovalFailureReason.Type;

export class ComputerUseApprovalError extends Schema.TaggedError<ComputerUseApprovalError>()(
  "ComputerUseApprovalError",
  {
    reason: ComputerUseApprovalFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return COMPUTER_USE_APPROVAL_FAILURE_MESSAGES[this.reason];
  }
}
