"use client";

import { useRef, useState } from "react";

import { sendToDirectorAction, stopDirectorAction } from "@/app/director-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useExternalSync } from "@/hooks/use-external-sync";
import type { ChatEntry, DirectorStatus, DirectorUpdate } from "@/server/director/chat";

type View = {
  entries: ChatEntry[];
  status: DirectorStatus;
  draft: string;
  connected: boolean;
  error?: string;
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
      return { ...view, entries, error: undefined };
    }
    case "draft":
      return { ...view, draft: update.text };
    case "status":
      return { ...view, status: update.status };
  }
}

export default function ChatPage() {
  const [view, setView] = useState(initialView);
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const answering = view.status === "answering";

  useExternalSync(() => {
    const source = new EventSource("/api/director/events");
    source.onmessage = (message) => {
      const update = JSON.parse(message.data) as DirectorUpdate;
      setView((current) => apply(current, update));
    };
    source.onerror = () => setView((current) => ({ ...current, connected: false }));
    return () => source.close();
  }, []);

  useExternalSync(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view.entries, view.draft]);

  const send = () => {
    const message = text;
    if (!message.trim() || answering) return;
    setText("");
    void sendToDirectorAction(message).then((result) => {
      if (result.error) setView((current) => ({ ...current, error: result.error }));
    });
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">
        BusyBoy
      </header>
      <div
        ref={scroller}
        role="log"
        aria-label="Transcript"
        data-connected={view.connected ? "true" : "false"}
        className="min-h-0 flex-1 overflow-auto px-4 py-4"
      >
        {view.entries.length === 0 && !view.draft ? (
          <p className="text-muted-foreground text-sm">BusyBoy is ready. What should we work on?</p>
        ) : null}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
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
      <form
        className="mx-auto flex w-full max-w-3xl shrink-0 items-end gap-2 border-t px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Textarea
          aria-label="Message"
          value={text}
          placeholder="Message"
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <Button type="submit" disabled={answering || text.trim().length === 0}>
          Send
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!answering}
          onClick={() => void stopDirectorAction()}
        >
          Stop
        </Button>
      </form>
      {view.error ? (
        <p role="alert" className="text-destructive px-4 pb-3 text-sm">
          {view.error}
        </p>
      ) : null}
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
