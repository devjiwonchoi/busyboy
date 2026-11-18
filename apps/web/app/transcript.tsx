"use client";

import { useState, type ReactNode } from "react";

import { useExternalSync } from "@/hooks/use-external-sync";
import type { ChatEntry, DirectorStatus, DirectorUpdate } from "@/server/director/chat";

type View = {
  entries: ChatEntry[];
  status: DirectorStatus;
  draft: string;
  connected: boolean;
};

const initialView: View = {
  entries: [],
  status: "idle",
  draft: "",
  connected: false,
};

function apply(view: View, update: DirectorUpdate): View {
  switch (update.type) {
    case "reset":
      return {
        entries: update.entries,
        status: update.status,
        draft: update.draft,
        connected: true,
      };
    case "entry": {
      const index = view.entries.findIndex(({ id }) => id === update.entry.id);
      const entries = [...view.entries];
      if (index === -1) entries.push(update.entry);
      else entries[index] = update.entry;
      return { ...view, entries };
    }
    case "draft":
      return { ...view, draft: update.text };
    case "status":
      return { ...view, status: update.status };
  }
}

export function Transcript({ empty }: { empty: ReactNode }) {
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

  return (
    // why: column-reverse keeps the scroll pinned to the newest message without measuring it.
    <div
      role="log"
      aria-label="Transcript"
      data-connected={view.connected ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col-reverse overflow-auto px-4 py-4"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {view.entries.length === 0 && !view.draft ? empty : null}
        {view.entries.map((entry) => (
          <MessageView key={entry.id} entry={entry} />
        ))}
        {view.draft ? (
          <article aria-label="Reply">
            <p className="text-muted-foreground mb-1 text-xs">Director</p>
            <p className="whitespace-pre-wrap text-sm">{view.draft}</p>
          </article>
        ) : null}
      </div>
    </div>
  );
}

function MessageView({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "note") {
    return (
      <p
        role="status"
        className={
          entry.tone === "error" ? "text-destructive text-sm" : "text-muted-foreground text-sm"
        }
      >
        {entry.text}
      </p>
    );
  }
  const label = entry.kind === "user" ? "You" : "Director";
  return (
    <article aria-label={entry.kind === "user" ? "Your message" : "Reply"}>
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
    </article>
  );
}
