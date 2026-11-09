import { SymbolView } from "../../components/ui/AppSymbol";
import { Pressable, View } from "react-native";

export interface SidebarHeaderActionsProps {
  readonly onOpenGoalMap: () => void;
  readonly onOpenSettings: () => void;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "point.3.connected.trianglepath.dotted" | "square.and.pencil";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="flex-row items-center gap-0.5">
      <FallbackHeaderButton
        accessibilityLabel="전체 프로젝트"
        icon="point.3.connected.trianglepath.dotted"
        onPress={props.onOpenGoalMap}
      />
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
