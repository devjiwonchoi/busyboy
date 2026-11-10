import type { ExecutionLocation } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";

const MOVE_LABEL: Record<ExecutionLocation, string> = {
  cloud: "클라우드로 옮기기",
  local: "로컬로 가져오기",
};
const MOVING_LABEL: Record<ExecutionLocation, string> = {
  cloud: "클라우드로 옮기는 중…",
  local: "로컬로 가져오는 중…",
};

export interface MoveTaskControlProps {
  readonly location: ExecutionLocation;
  /** Where the lead is going while a move runs; null otherwise. */
  readonly movingTo: ExecutionLocation | null;
  /** Why the move can't start; null when it can. */
  readonly disabledReason: string | null;
  readonly onMove: (to: ExecutionLocation) => void;
  /** Touch has no hover, so pressing a disabled button tells why. */
  readonly onExplainDisabled: (reason: string) => void;
}

/** One move toward the other place, or a quiet pill while the lead moves. */
export function MoveTaskButton(props: MoveTaskControlProps) {
  if (props.movingTo !== null) {
    return (
      <View
        accessible
        accessibilityLabel={MOVING_LABEL[props.movingTo]}
        testID="thread-move-task-moving"
        className="flex-row items-center gap-1 rounded-full border border-border px-2 py-0.5"
      >
        <AppActivityIndicator size="small" />
        <Text className="text-2xs text-foreground-muted">{MOVING_LABEL[props.movingTo]}</Text>
      </View>
    );
  }
  const to: ExecutionLocation = props.location === "cloud" ? "local" : "cloud";
  const reason = props.disabledReason;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={MOVE_LABEL[to]}
      accessibilityHint={reason ?? undefined}
      accessibilityState={{ disabled: reason !== null }}
      testID={`thread-move-task-${to}`}
      onPress={() => (reason === null ? props.onMove(to) : props.onExplainDisabled(reason))}
      className={`rounded-full border border-border px-2 py-0.5 ${reason === null ? "" : "opacity-50"}`}
    >
      <Text className="text-2xs text-foreground-muted">{MOVE_LABEL[to]}</Text>
    </Pressable>
  );
}
