"use client";

import { useEffect } from "react";

import { desktopBridge } from "@/lib/desktop-bridge";
import { FOCUS_PARAM, parseFocusTarget } from "@/lib/focus-target";

// A fresh window gets the target as ?focus=; an open one gets it from the preload bridge, so the page does not reload.
export function FocusHandler() {
  useEffect(() => {
    const show = (value: string | null) => {
      const target = parseFocusTarget(value);
      if (target?.kind !== "director") return;
      document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]')?.focus();
    };
    const url = new URL(window.location.href);
    const initial = url.searchParams.get(FOCUS_PARAM);
    if (initial) {
      // A reload should not jump back to it.
      url.searchParams.delete(FOCUS_PARAM);
      window.history.replaceState(window.history.state, "", url);
      show(initial);
    }
    // A browser without the desktop app, or an older preload, has no onFocus.
    return desktopBridge()?.onFocus?.(show);
  }, []);

  return null;
}
