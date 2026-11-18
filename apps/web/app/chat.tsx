"use client";

import { useState } from "react";

import type { ChatEntry, DirectorStatus, DirectorUpdate } from "@/server/director/chat";

import { Composer } from "./composer";
import { Transcript } from "./transcript";

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

export function Chat() {
  const [view, setView] = useState(initialView);

  const openStreamWhileMounted = (node: HTMLDivElement | null) => {
    if (!node) return;
    const source = new EventSource("/api/director/events");
    source.onmessage = (message) => {
      const update = JSON.parse(message.data) as DirectorUpdate;
      setView((current) => apply(current, update));
    };
    source.onerror = () => setView((current) => ({ ...current, connected: false }));
    return () => source.close();
  };

  return (
    <div ref={openStreamWhileMounted} className="contents">
      <Transcript view={view} />
      <Composer
        answering={view.status === "answering"}
        error={view.error}
        onError={(error) => setView((current) => ({ ...current, error }))}
      />
    </div>
  );
}
