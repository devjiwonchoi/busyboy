import type {
  ComputerUseApprovalAnswerInput,
  ComputerUseApprovalDecision,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export type ComputerUseApprovalItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "computer_use_approval" }
>;

export type ComputerUseApprovalDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | { readonly kind: "answered"; readonly allowed: boolean; readonly label: string };

/**
 * `visibility` is the projected row's: a card inherited from another thread
 * (a fork) can only be answered where it was asked.
 */
export function computerUseApprovalDisplay(
  item: Pick<ComputerUseApprovalItem, "approvalStatus">,
  visibility: "local" | "inherited" | "synthetic",
): ComputerUseApprovalDisplay {
  switch (item.approvalStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: "Waiting for an answer in the original thread" };
    case "allowed_once":
      return { kind: "answered", allowed: true, label: "Allowed for this turn" };
    case "allowed_thread":
      return { kind: "answered", allowed: true, label: "Allowed in this thread" };
    case "allowed_always":
      return { kind: "answered", allowed: true, label: "Always allowed" };
    case "denied":
      return { kind: "answered", allowed: false, label: "Not allowed" };
    case "cancelled":
      return { kind: "answered", allowed: false, label: "Request ended" };
  }
}

export function computerUseApprovalAnswerInput(
  item: Pick<ComputerUseApprovalItem, "id" | "threadId">,
  decision: ComputerUseApprovalDecision,
): ComputerUseApprovalAnswerInput {
  return { threadId: item.threadId, turnItemId: item.id, decision };
}

const USER_FACING_FAILURE_TAGS = new Set([
  "ComputerUseApprovalError",
  "EnvironmentAuthorizationError",
]);

/**
 * Only known server errors pass their message through; anything else gets the
 * generic copy.
 */
export function computerUseApprovalFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
