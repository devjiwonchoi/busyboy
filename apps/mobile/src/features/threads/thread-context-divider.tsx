import { useState, type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ShimmeringWorkContent } from "./thread-work-log";

export function ThreadContextDivider(props: {
  label: string;
  icon: AppSymbolName;
  iconColor: ColorValue;
  active?: boolean;
  failed?: boolean;
  children?: ReactNode;
}) {
  return (
    <View className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <View className="h-px min-w-2 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        <SymbolView name={props.icon} size={12} tintColor={props.iconColor} type="monochrome" />
        {props.active ? (
          <ShimmeringWorkContent
            className="flex-none"
            textClassName="font-t3-medium"
            compact
            icon="brain"
            iconSubtleColor={props.iconColor}
            label={props.label}
            showIcon={false}
          />
        ) : (
          <Text
            className={
              props.failed
                ? "font-t3-medium text-xs text-danger-foreground"
                : "font-t3-medium text-xs text-foreground-muted"
            }
          >
            {props.label}
          </Text>
        )}
        {props.children}
      </View>
      <View className="h-px min-w-2 flex-1 bg-separator" />
    </View>
  );
}

/**
 * A context compaction is housekeeping, so the feed marks it with a small icon
 * instead of a divider. Pressing the icon shows what it did.
 */
export function ThreadCompactionMarker(props: {
  id: string;
  label: string;
  iconColor: ColorValue;
  active?: boolean;
}) {
  // Keyed by id so a recycled feed row does not carry another marker's state.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = expandedId === props.id;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ expanded }}
      className="mb-3 flex-row items-center gap-1.5 self-start px-1 py-1"
      hitSlop={8}
      onPress={() => setExpandedId(expanded ? null : props.id)}
    >
      <SymbolView
        name="arrow.down.right.and.arrow.up.left"
        size={12}
        tintColor={props.iconColor}
        type="monochrome"
      />
      {expanded ? (
        props.active ? (
          <ShimmeringWorkContent
            className="flex-none"
            textClassName="font-t3-medium"
            compact
            icon="brain"
            iconSubtleColor={props.iconColor}
            label={props.label}
            showIcon={false}
          />
        ) : (
          <Text className="font-t3-medium text-xs text-foreground-muted">{props.label}</Text>
        )
      ) : null}
    </Pressable>
  );
}
