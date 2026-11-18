"use client";

import { useState, useSyncExternalStore } from "react";

import { useExternalSync } from "@/hooks/use-external-sync";
import { desktopBridge } from "@/lib/desktop-bridge";

function subscribeNothing() {
  return () => {};
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/;

export function AppVersionLabel() {
  // why: The server has no desktop bridge. The first render stays empty so it matches, then the client reads the bridge.
  const client = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  useExternalSync(() => {
    if (!client) return;
    const read = desktopBridge()?.appVersion;
    if (!read) {
      setVersion(null);
      return;
    }
    let stopped = false;
    void read().then(
      (value) => {
        if (!stopped) setVersion(VERSION.test(value) ? value : null);
      },
      () => {
        if (!stopped) setVersion(null);
      },
    );
    return () => {
      stopped = true;
    };
  }, [client]);
  if (!client || version === undefined) return null;
  if (version) return <p className="text-muted-foreground text-xs">BusyBoy {version}</p>;
  if (desktopBridge()?.appVersion) return null;
  return <p className="text-muted-foreground text-xs">BusyBoy dev</p>;
}
