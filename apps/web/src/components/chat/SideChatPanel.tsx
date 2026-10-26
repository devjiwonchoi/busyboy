import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MessagesSquareIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

/** A separate session in the thread's right panel, sharing no context with the thread. */
export function SideChatPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly onNewSideChat: () => void;
  /** Renders the side chat's own chat view, which the page's ChatView supplies. */
  readonly renderChat: (threadId: ThreadId) => ReactNode;
}) {
  const threadRef = scopeThreadRef(props.environmentId, ThreadId.make(props.threadId));
  const thread = useQuietThreadShell(threadRef);
  const available = thread !== null && thread.deletedAt == null;

  return (
    // Focusable so a click inside moves focus here, and shortcuts and pastes follow it.
    <div
      data-side-chat
      tabIndex={-1}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background outline-none"
    >
      {available ? (
        props.renderChat(threadRef.threadId)
      ) : (
        <Empty className="min-h-0 justify-center-safe">
          <EmptyMedia variant="icon">
            <MessagesSquareIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Side chat unavailable</EmptyTitle>
            <EmptyDescription>Its thread was deleted.</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" variant="outline" onClick={props.onNewSideChat}>
            <PlusIcon aria-hidden className="size-3.5" />
            New side chat
          </Button>
        </Empty>
      )}
    </div>
  );
}
