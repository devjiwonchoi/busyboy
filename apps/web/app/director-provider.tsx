"use client";

import { createContext, use, useCallback, useState, type ReactNode } from "react";

import type { ChatEntry, DirectorStatus, DirectorUpdate } from "@/server/director/chat";

export type DirectorView = {
  entries: ChatEntry[];
  status: DirectorStatus;
  draft: string;
  connected: boolean;
  revision: number;
  error?: string;
};

const initialView: DirectorView = {
  entries: [],
  status: "idle",
  draft: "",
  connected: false,
  revision: 0,
};

function apply(current: DirectorView, update: DirectorUpdate): DirectorView {
  switch (update.type) {
    case "reset":
      return {
        entries: update.entries,
        status: update.status,
        draft: update.draft,
        connected: true,
        revision: current.revision + 1,
      };
    case "entry": {
      const index = current.entries.findIndex(({ id }) => id === update.entry.id);
      const entries = [...current.entries];
      if (index === -1) entries.push(update.entry);
      else entries[index] = update.entry;
      return { ...current, entries, error: undefined, revision: current.revision + 1 };
    }
    case "draft":
      return { ...current, draft: update.text, revision: current.revision + 1 };
    case "status":
      return { ...current, status: update.status };
  }
}

type DirectorContextValue = DirectorView & { showError: (error: string) => void };

const DirectorContext = createContext<DirectorContextValue | null>(null);

// why: The transcript and the composer are separate client components that both need the stream, so they share one connection.
export function DirectorProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState(initialView);

  // why: A ref callback's cleanup runs on unmount, so the stream lives exactly as long as the chat is mounted.
  const connect = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const source = new EventSource("/api/director/events");
    source.onmessage = (message) => {
      const update = JSON.parse(message.data) as DirectorUpdate;
      setView((current) => apply(current, update));
    };
    source.onerror = () => setView((current) => ({ ...current, connected: false }));
    return () => source.close();
  }, []);

  const showError = (error: string) => setView((current) => ({ ...current, error }));

  return (
    <DirectorContext value={{ ...view, showError }}>
      <div ref={connect} className="contents">
        {children}
      </div>
    </DirectorContext>
  );
}

export function useDirector() {
  const value = use(DirectorContext);
  if (!value) throw new Error("useDirector must be used inside DirectorProvider.");
  return value;
}
