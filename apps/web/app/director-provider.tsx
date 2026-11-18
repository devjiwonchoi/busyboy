"use client";

import { createContext, use, useState, type ReactNode } from "react";

import { useExternalSync } from "@/hooks/use-external-sync";
import type { ChatEntry, DirectorStatus, DirectorUpdate } from "@/server/director/chat";

export type DirectorView = {
  entries: ChatEntry[];
  status: DirectorStatus;
  draft: string;
  connected: boolean;
  error?: string;
};

const initialView: DirectorView = {
  entries: [],
  status: "idle",
  draft: "",
  connected: false,
};

function apply(current: DirectorView, update: DirectorUpdate): DirectorView {
  switch (update.type) {
    case "reset":
      return {
        entries: update.entries,
        status: update.status,
        draft: update.draft,
        connected: true,
      };
    case "entry": {
      const index = current.entries.findIndex(({ id }) => id === update.entry.id);
      const entries = [...current.entries];
      if (index === -1) entries.push(update.entry);
      else entries[index] = update.entry;
      return { ...current, entries, error: undefined };
    }
    case "draft":
      return { ...current, draft: update.text };
    case "status":
      return { ...current, status: update.status };
  }
}

type DirectorContextValue = DirectorView & { showError: (error: string) => void };

const DirectorContext = createContext<DirectorContextValue | null>(null);

// why: The transcript and the composer are separate client components that both need the stream, so they share one connection.
export function DirectorProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState(initialView);

  useExternalSync(() => {
    const source = new EventSource("/api/director/events");
    source.onmessage = (message) => {
      const update = JSON.parse(message.data) as DirectorUpdate;
      setView((current) => apply(current, update));
    };
    source.onerror = () => setView((current) => ({ ...current, connected: false }));
    return () => source.close();
  }, []);

  const showError = (error: string) => setView((current) => ({ ...current, error }));

  return <DirectorContext value={{ ...view, showError }}>{children}</DirectorContext>;
}

export function useDirector() {
  const value = use(DirectorContext);
  if (!value) throw new Error("useDirector must be used inside DirectorProvider.");
  return value;
}
