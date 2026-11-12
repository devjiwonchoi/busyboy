import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Ref from "effect/Ref";

export interface DispatchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface DispatchModeRefusal extends DispatchModes {
  readonly threadId: ThreadId;
  readonly mode: "runtime" | "interaction";
}

/**
 * A caller checks its target's modes before dispatching, but the target's user can raise them
 * meanwhile; the orchestrator re-checks this limit inside the thread's command lock, where nothing
 * else can change them.
 */
export interface DispatchModeLimitValue extends DispatchModes {
  readonly refused?: Ref.Ref<DispatchModeRefusal | undefined>;
  /** Exact targets approved by the user for this tool call only. */
  readonly approvedTargets?: ReadonlyArray<DispatchModes & { readonly threadId: ThreadId }>;
}

export const isApprovedDispatchTarget = (
  limit: DispatchModeLimitValue | undefined,
  threadId: ThreadId,
  modes: DispatchModes,
) =>
  limit?.approvedTargets?.some(
    (target) =>
      target.threadId === threadId &&
      target.runtimeMode === modes.runtimeMode &&
      target.interactionMode === modes.interactionMode,
  ) === true;

export const approvedDispatchTargetModeMismatch = (
  limit: DispatchModeLimitValue | undefined,
  threadId: ThreadId,
  modes: DispatchModes,
): "runtime" | "interaction" | undefined => {
  const approved = limit?.approvedTargets?.find((target) => target.threadId === threadId);
  if (approved === undefined) {
    return undefined;
  }
  if (approved.runtimeMode !== modes.runtimeMode) {
    return "runtime";
  }
  return approved.interactionMode !== modes.interactionMode ? "interaction" : undefined;
};

export const DispatchModeLimit = Context.Reference<DispatchModeLimitValue | undefined>(
  "t3/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

export const exceededDispatchModeLimit = (
  limit: DispatchModes,
  modes: DispatchModes,
): "runtime" | "interaction" | undefined =>
  runtimeModeRank[modes.runtimeMode] > runtimeModeRank[limit.runtimeMode]
    ? "runtime"
    : interactionModeRank[modes.interactionMode] > interactionModeRank[limit.interactionMode]
      ? "interaction"
      : undefined;
