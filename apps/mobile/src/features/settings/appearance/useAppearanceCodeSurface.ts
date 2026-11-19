import { useMemo } from "react";

import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../../lib/appearancePreferences";
import { createNativeSourceStyle } from "../../files/nativeSourceFileAdapter";
import { createNativeReviewDiffStyle } from "../../review/nativeReviewDiffAdapter";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export function useAppearanceCodeSurface(): {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly codeWordBreak: boolean;
  readonly nativeSourceStyle: ReturnType<typeof createNativeSourceStyle>;
  readonly nativeReviewDiffStyle: ReturnType<typeof createNativeReviewDiffStyle>;
} {
  const { appearance } = useAppearancePreferences();
  const codeSurface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize),
    [appearance.codeFontSize],
  );
  const nativeSourceStyle = useMemo(() => createNativeSourceStyle(codeSurface), [codeSurface]);
  const nativeReviewDiffStyle = useMemo(
    () => createNativeReviewDiffStyle(codeSurface, appearance.codeWordBreak),
    [appearance.codeWordBreak, codeSurface],
  );

  return {
    codeSurface,
    codeWordBreak: appearance.codeWordBreak,
    nativeSourceStyle,
    nativeReviewDiffStyle,
  };
}
