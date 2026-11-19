import { Platform } from "react-native";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { resolveAndroidControlSizing } from "../../lib/androidControlSizing";
import { DEFAULT_BASE_FONT_SIZE } from "../../lib/appearancePreferences";

export function useAndroidControlSizing() {
  const { appearance } = useAppearancePreferences();
  return resolveAndroidControlSizing(
    Platform.OS === "android" ? appearance.baseFontSize : DEFAULT_BASE_FONT_SIZE,
  );
}
