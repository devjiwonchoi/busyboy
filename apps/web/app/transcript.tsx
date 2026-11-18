import { FileText } from "lucide-react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { attachmentUrl, type MessageAttachment } from "@/lib/chat-attachments";
import type { ChatEntry } from "@/server/director/chat";

import type { DirectorView } from "./chat";
import { MessageActions } from "./message-actions";

export function Transcript({ view }: { view: DirectorView }) {
  return (
    <div
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
        {view.draft ? <ReplyBubble text={view.draft} /> : null}
        {view.status === "answering" && !view.draft ? <Thinking /> : null}
        <div key={view.revision} ref={scrollLogToEnd} />
      </div>
    </div>
  );
}

function scrollLogToEnd(node: HTMLDivElement | null) {
  const log = node?.closest<HTMLElement>("[role=log]");
  if (log) log.scrollTop = log.scrollHeight;
}

function Thinking() {
  return (
    <p
      role="status"
      aria-label="Thinking"
      className="text-muted-foreground flex items-center gap-1.5 text-sm"
    >
      <span className="flex gap-0.5" aria-hidden>
        <span className="bg-muted-foreground size-1 animate-pulse rounded-full" />
        <span className="bg-muted-foreground size-1 animate-pulse rounded-full [animation-delay:150ms]" />
        <span className="bg-muted-foreground size-1 animate-pulse rounded-full [animation-delay:300ms]" />
      </span>
      Thinking…
    </p>
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
  if (entry.kind === "user") {
    return <UserBubble text={entry.text} attachments={entry.attachments} />;
  }
  return <ReplyBubble text={entry.text} copyable />;
}

function UserBubble({ text, attachments }: { text: string; attachments?: MessageAttachment[] }) {
  return (
    <article aria-label="Your message" className="group/message">
      <Message align="end">
        <MessageContent>
          {attachments?.length ? <SentAttachments attachments={attachments} /> : null}
          {text ? (
            <div className="flex w-full min-w-0 flex-col items-end gap-1">
              <Bubble>
                <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
              </Bubble>
              <MessageActions text={text} />
            </div>
          ) : null}
        </MessageContent>
      </Message>
    </article>
  );
}

function ReplyBubble({ text, copyable = false }: { text: string; copyable?: boolean }) {
  return (
    <article aria-label="Reply" className="group/message">
      <Message>
        <MessageContent>
          <div className="flex w-full min-w-0 flex-col items-start gap-1">
            <Bubble variant="muted">
              <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
            </Bubble>
            {copyable ? <MessageActions text={text} /> : null}
          </div>
        </MessageContent>
      </Message>
    </article>
  );
}

function SentAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  return (
    <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment) => (
        <li key={attachment.file}>
          {attachment.image ? (
            // oxlint-disable-next-line nextjs/no-img-element -- a saved attachment is served by a trusted route, not next/image
            <img
              src={attachmentUrl(attachment)}
              alt={attachment.name}
              className="max-h-48 max-w-64 rounded-xl border object-cover"
            />
          ) : (
            <span className="bg-muted flex max-w-56 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs">
              <FileText className="size-3.5 shrink-0" />
              <span className="truncate">{attachment.name}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
