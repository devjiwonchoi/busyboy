import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { OneChatScreen } from "./one-chat-screen";

/** Settings and task pages keep the classic layout, so the switch can always be turned off. */
export function keepsClassicLayout(pathname: string): boolean {
  return pathname.startsWith("/settings") || pathname.startsWith("/tasks/");
}

/** The one place that picks the one chat screen over the classic layout. */
export function OneChatGate({ children }: { children: ReactNode }) {
  const enabled = useClientSettings((settings) => settings.oneChatScreenEnabled);
  const pathname = useLocation({ select: (location) => location.pathname });
  if (!enabled || keepsClassicLayout(pathname)) return <>{children}</>;
  return <OneChatScreen />;
}
