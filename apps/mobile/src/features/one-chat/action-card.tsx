import type { EnvironmentId } from "@t3tools/contracts";
import type { ActionCard as ActionCardModel, ActionCardOption } from "@t3tools/shared/one-chat";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useTaskSpec } from "./use-task-spec";

export const RECOMMENDED_SUFFIX = " (Recommended)";

/** One card in the chat: who asks, one question, one gray line, and the choices. */
export function ActionCard(props: {
  readonly card: ActionCardModel;
  readonly environmentId: EnvironmentId | null;
  readonly answeredLabel: string | null;
  readonly highlighted: boolean;
  readonly onAnswer: (card: ActionCardModel, option: ActionCardOption) => void;
  readonly onOpenDetails: (card: ActionCardModel) => void;
}) {
  const { card } = props;
  const answered = props.answeredLabel ?? card.answered?.label ?? null;
  const isPlan = card.kind === "plan";
  const spec = useTaskSpec(props.environmentId, card.projectId, card.taskId, isPlan && !answered);
  const nonGoals = spec?.nonGoals.trim() ?? "";
  return (
    <View
      testID="action-card"
      className={`mx-4 my-1.5 gap-2 rounded-2xl border px-4 py-3 ${
        props.highlighted ? "border-primary bg-primary/10" : "border-border bg-card"
      }`}
    >
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {card.projectName} · {card.taskTitle}
      </Text>
      <Text testID="action-card-question" className="font-t3-bold text-sm" numberOfLines={1}>
        {card.question}
      </Text>
      {answered !== null ? (
        <Text testID="action-card-answer" className="text-sm text-foreground-secondary">
          You chose: {answered}
        </Text>
      ) : (
        <>
          {card.subline ? (
            <Text testID="action-card-subline" className="text-sm text-foreground-muted">
              {card.subline}
            </Text>
          ) : null}
          {isPlan && card.criteria.length > 0 ? (
            <View className="gap-0.5">
              {card.criteria.map((criterion, index) => (
                <Text key={`${index}:${criterion}`} className="text-sm text-foreground-secondary">
                  • {criterion}
                </Text>
              ))}
            </View>
          ) : null}
          {isPlan && nonGoals ? (
            <Text className="text-sm text-foreground-muted">Do not: {nonGoals}</Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2 pt-1">
            {card.options.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                onPress={() => props.onAnswer(card, option)}
                className={`rounded-full px-3 py-1.5 ${
                  option.recommended ? "bg-primary" : "border border-border"
                }`}
              >
                <Text
                  className={`text-sm ${
                    option.recommended ? "text-primary-foreground" : "text-foreground"
                  }`}
                >
                  {option.label}
                  {option.recommended ? RECOMMENDED_SUFFIX : ""}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onOpenDetails(card)}
              className="rounded-full px-3 py-1.5"
            >
              <Text className="text-sm text-foreground-secondary">Details</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
