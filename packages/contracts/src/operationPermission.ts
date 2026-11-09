import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

export const OperationPermissionStatus = Schema.Literals([
  "pending",
  "approved",
  "declined",
  "cancelled",
  "expired",
  "consumed",
  "succeeded",
  "failed",
]);
export type OperationPermissionStatus = typeof OperationPermissionStatus.Type;

/** Only the authenticated app answer path accepts an execution approval. */
export const OperationPermissionAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  decision: Schema.Literals(["allow", "deny"]),
});
export type OperationPermissionAnswerInput = typeof OperationPermissionAnswerInput.Type;

export class OperationPermissionError extends Schema.TaggedError<OperationPermissionError>()(
  "OperationPermissionError",
  {
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}
