import type { MaterialYouPalette } from "./materialYouPalette";
import type { MobileThemeAppearance, MobileThemeVariables } from "./mobileTheme";

export function materialYouPaletteToMobileThemeVariables(
  _palette: MaterialYouPalette,
  _appearance: MobileThemeAppearance,
  base: MobileThemeVariables,
): MobileThemeVariables {
  return base;
}
