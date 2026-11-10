import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** Marks a task lead that runs in a cloud sandbox; the thread looks the same otherwise. */
export function CloudPill() {
  return (
    <View
      accessible
      accessibilityLabel="Cloud, runs in a cloud sandbox"
      testID="thread-cloud-pill"
      className="rounded-full border border-border px-2 py-0.5"
    >
      <Text className="text-2xs text-foreground-muted">Cloud</Text>
    </View>
  );
}
