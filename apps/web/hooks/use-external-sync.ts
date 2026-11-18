"use client";

import { useEffect, type DependencyList } from "react";

export function useExternalSync(sync: () => void | (() => void), deps?: DependencyList): void {
  // oxlint-disable-next-line react/exhaustive-deps -- why: the caller owns the dependency list, the same contract as useEffect
  useEffect(() => sync(), deps);
}
