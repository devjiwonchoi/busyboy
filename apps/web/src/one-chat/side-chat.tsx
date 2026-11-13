import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { MessageBubbles } from "./chat-bubbles";
import { OneChatComposer } from "./one-chat-composer";
import type { OneChatCommands } from "./one-chat-commands";
import { useThreadView } from "./one-chat-data";

export const SIDE_CHAT_TITLE = "Side chat";

/** What the side chat copies from the Director thread to start its own. */
export interface SideChatSource {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * A throwaway chat beside the main one. It makes its own thread when it opens and deletes it
 * when it closes; it never writes to the Director thread or any task.
 */
export function SideChat({
  open,
  onOpenChange,
  source,
  commands,
  onQuote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: SideChatSource | null;
  commands: OneChatCommands;
  onQuote: (text: string) => void;
}) {
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [failed, setFailed] = useState(false);
  const creatingRef = useRef(false);
  const threadIdRef = useRef<ThreadId | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    if (!open || source === null || threadIdRef.current !== null || creatingRef.current) return;
    creatingRef.current = true;
    setFailed(false);
    void commands
      .createTempThread({ ...source, title: SIDE_CHAT_TITLE })
      .then((created) => {
        creatingRef.current = false;
        if (created === null) {
          setFailed(true);
          return;
        }
        threadIdRef.current = created;
        setThreadId(created);
      });
  }, [open, source, commands]);

  const removeThread = () => {
    const current = threadIdRef.current;
    const environmentId = sourceRef.current?.environmentId;
    threadIdRef.current = null;
    setThreadId(null);
    if (current !== null && environmentId !== undefined) {
      void commandsRef.current.deleteThread(environmentId, current);
    }
  };

  // Leaving the screen with the side chat open still removes its thread.
  useEffect(() => () => removeThread(), []);

  const ref = threadId !== null && source !== null ? scopeThreadRef(source.environmentId, threadId) : null;
  const view = useThreadView(ref);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) removeThread();
        onOpenChange(next);
      }}
    >
      <SheetPopup side="right" data-one-chat-side-chat className="flex flex-col">
        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-base">{SIDE_CHAT_TITLE}</SheetTitle>
          <SheetDescription className="text-xs">Temporary · gone when closed</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          {view.messages.map((message) => (
            <MessageBubbles
              key={message.id}
              message={message}
              threadRef={ref}
              assistantAction={(text) => (
                <button
                  type="button"
                  data-one-chat-quote
                  className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                  onClick={() => onQuote(text)}
                >
                  Quote in main chat
                </button>
              )}
            />
          ))}
          {view.running ? (
            <p role="status" className="text-muted-foreground text-xs">
              Working…
            </p>
          ) : null}
          {failed ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              Could not start the side chat.
            </p>
          ) : null}
        </div>
        <div className="shrink-0 border-t p-3">
          <OneChatComposer
            draftKey={null}
            running={view.running}
            disabled={ref === null}
            mentions={[]}
            label={SIDE_CHAT_TITLE}
            placeholder="Ask on the side"
            onStop={() => {
              if (ref !== null) void commands.stop(ref.environmentId, ref.threadId);
            }}
            onSend={(text, attachments) => {
              if (ref === null || source === null) return Promise.resolve(false);
              return commands.send({
                environmentId: ref.environmentId,
                threadId: ref.threadId,
                text,
                attachments,
                runtimeMode: source.runtimeMode,
                interactionMode: source.interactionMode,
              });
            }}
          />
        </div>
      </SheetPopup>
    </Sheet>
  );
}
