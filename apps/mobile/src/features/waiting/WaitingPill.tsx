import { waitingItemKeys } from "@t3tools/shared/waitingAlerts";
import { useEffect, useRef } from "react";
import { Pressable } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { AppText as Text } from "../../components/ui/AppText";
import { useHomeThreadSelection } from "../home/home-thread-navigation";
import { useWaitingEntries } from "./useWaitingAlerts";

export function WaitingPill() {
  const entries = useWaitingEntries();
  const { total } = waitingItemKeys(entries);
  const director = entries.find((entry) => entry.summary.kind === "director");
  const selectThread = useHomeThreadSelection();
  const previous = useRef(total);
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  useEffect(() => {
    if (total > previous.current && !reduceMotion) {
      scale.value = withSequence(
        withTiming(1.025, { duration: 300 }),
        withTiming(1, { duration: 900 }),
      );
    }
    previous.current = total;
  }, [total, reduceMotion, scale]);
  if (total === 0) {
    return null;
  }
  return (
    <Animated.View style={animatedStyle} className="mx-4 my-2 self-start">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`기다리는 일 ${total}개`}
        disabled={!director}
        className="rounded-full border border-warning-border bg-warning px-3 py-1.5"
        onPress={() => {
          if (director) {
            selectThread({
              environmentId: director.environmentId,
              id: director.summary.pmThreadId,
            });
          }
        }}
      >
        <Text className="text-sm text-warning-foreground">기다리는 일 {total}개</Text>
      </Pressable>
    </Animated.View>
  );
}
