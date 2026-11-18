"use client";

import { useEffect, useReducer, useRef } from "react";

import type { ChatEntry, DirectorStatus, DirectorUpdate } from "@/server/director/chat";

import { Composer, type ComposerHandle } from "./composer";
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

type ChatAction = DirectorUpdate | { type: "disconnected" } | { type: "error"; error: string };

function apply(current: DirectorView, update: ChatAction): DirectorView {
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
    case "disconnected":
      return { ...current, connected: false };
    case "error":
      return { ...current, error: update.error };
  }
}

export function Chat() {
  const [view, dispatch] = useReducer(apply, initialView);
  const composer = useRef<ComposerHandle>(null);

  // oxlint-disable-next-line busyboy/no-unreasoned-effect -- keeps the director event stream open while the chat is mounted.
  useEffect(() => {
    const source = new EventSource("/api/director/events");
    source.onmessage = (message) => dispatch(JSON.parse(message.data) as DirectorUpdate);
    source.onerror = () => dispatch({ type: "disconnected" });
    return () => source.close();
  }, []);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        composer.current?.addFiles(event.dataTransfer.files);
      }}
    >
      <Transcript view={view} />
      <Composer
        ref={composer}
        answering={view.status === "answering"}
        error={view.error}
        onError={(error) => dispatch({ type: "error", error })}
      />
    </div>
  );
}
