import type { ScopedThreadRef } from "@t3tools/contracts";
import { splitAssistantMarkdownIntoBubbles } from "@t3tools/shared/chatBubbles";
import type { ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import type { FeedMessage } from "./one-chat-data";

/** One message as chat bubbles: the user's on the right, a reply split into left bubbles. */
export function MessageBubbles({
  message,
  threadRef,
  assistantAction,
}: {
  message: FeedMessage;
  threadRef: ScopedThreadRef | null;
  /** Shown under each assistant bubble, such as "Quote in main chat". */
  assistantAction?: (text: string) => ReactNode;
}) {
  if (message.role === "user") {
    return (
      <div
        data-one-chat-message="user"
        className="ms-auto max-w-[80%] whitespace-pre-wrap wrap-break-word rounded-2xl bg-primary px-3 py-2 text-primary-foreground text-sm"
      >
        {message.text}
      </div>
    );
  }
  const bubbles = splitAssistantMarkdownIntoBubbles(message.text);
  return (
    <>
      {bubbles.map((bubble, index) => (
        <div key={index} className="flex max-w-[85%] flex-col items-start gap-0.5 self-start">
          <div
            data-one-chat-message="assistant"
            className="min-w-0 rounded-2xl bg-muted px-3 py-2 text-sm"
          >
            <ChatMarkdown
              text={bubble}
              cwd={undefined}
              threadRef={threadRef ?? undefined}
              isStreaming={message.streaming && index === bubbles.length - 1}
            />
          </div>
          {assistantAction ? assistantAction(bubble) : null}
        </div>
      ))}
    </>
  );
}
