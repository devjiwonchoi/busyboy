import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { ChatEntry } from "@/server/director/chat";

import type { DirectorView } from "./chat";

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
        <div key={view.revision} ref={scrollLogToEnd} />
      </div>
    </div>
  );
}

function scrollLogToEnd(node: HTMLDivElement | null) {
  const log = node?.closest<HTMLElement>("[role=log]");
  if (log) log.scrollTop = log.scrollHeight;
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
    return <UserBubble text={entry.text} />;
  }
  return <ReplyBubble text={entry.text} />;
}

function UserBubble({ text }: { text: string }) {
  return (
    <article aria-label="Your message">
      <Message align="end">
        <MessageContent>
          <Bubble>
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </article>
  );
}

function ReplyBubble({ text }: { text: string }) {
  return (
    <article aria-label="Reply">
      <Message>
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </article>
  );
}
