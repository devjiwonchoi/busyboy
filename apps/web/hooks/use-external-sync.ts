"use client";

import { useEffect, type DependencyList } from "react";

export function useExternalSync(sync: () => void | (() => void), deps?: DependencyList): void {
  // oxlint-disable-next-line react/exhaustive-deps -- deps is the caller's list, the same parameter useEffect takes
  useEffect(() => sync(), deps);
}
