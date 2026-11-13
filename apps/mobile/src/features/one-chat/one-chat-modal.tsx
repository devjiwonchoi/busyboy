import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * A sheet that can grow to full screen. The toggle changes only the size; the content stays.
 * Pass `scroll={false}` when the children manage their own scrolling.
 */
export function OneChatModal(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly scroll?: boolean;
  readonly testID?: string;
}) {
  const [fullScreen, setFullScreen] = useState(false);
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={fullScreen ? "fullScreen" : "pageSheet"}
      onRequestClose={props.onClose}
    >
      <View
        testID={props.testID ?? "one-chat-modal"}
        className="flex-1 bg-sheet"
        style={{ paddingTop: fullScreen ? insets.top : 0 }}
      >
        <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <View className="flex-1">
            <Text className="font-t3-bold text-base text-foreground">{props.title}</Text>
            {props.subtitle ? (
              <Text className="text-xs text-foreground-muted">{props.subtitle}</Text>
            ) : null}
          </View>
          <Pressable accessibilityRole="button" onPress={() => setFullScreen((value) => !value)}>
            <Text className="text-sm text-foreground-secondary">
              {fullScreen ? "Exit full screen" : "Full screen"}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={props.onClose}>
            <Text className="text-sm text-primary">Close</Text>
          </Pressable>
        </View>
        {props.scroll === false ? (
          <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
            {props.children}
          </View>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 16 }}
          >
            {props.children}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
