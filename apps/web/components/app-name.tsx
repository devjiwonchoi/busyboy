"use client";

import { useSyncExternalStore } from "react";

import { DESKTOP_BRIDGE_KEY, type DesktopBridge } from "@/lib/desktop-bridge";

const subscribe = () => () => {};

function isDevRun() {
  if (process.env.NODE_ENV === "development") return true;
  const bridge = (window as unknown as Record<string, DesktopBridge | undefined>)[
    DESKTOP_BRIDGE_KEY
  ];
  return bridge?.isDevRun === true;
}

export function AppName() {
  const dev = useSyncExternalStore(subscribe, isDevRun, () => false);
  return <>{dev ? "BusyBoy (dev)" : "BusyBoy"}</>;
}
