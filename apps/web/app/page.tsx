import { Button } from "@/components/ui/button";
import { MAX_MESSAGE_LENGTH } from "@/server/director/chat";

import { sendToDirectorAction, stopDirectorAction } from "./director-actions";
import { MessageInput } from "./message-input";
import { Transcript } from "./transcript";

export default function ChatPage() {
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">
        BusyBoy
      </header>
      <Transcript
        empty={
          <p className="text-muted-foreground text-sm">BusyBoy is ready. What should we work on?</p>
        }
      />
      <div className="mx-auto flex w-full max-w-3xl shrink-0 items-end gap-2 border-t px-4 py-3">
        <form action={sendToDirectorAction} className="flex flex-1 items-end gap-2">
          <MessageInput maxLength={MAX_MESSAGE_LENGTH} />
          <Button type="submit">Send</Button>
        </form>
        <form action={stopDirectorAction}>
          <Button type="submit" variant="outline">
            Stop
          </Button>
        </form>
      </div>
    </div>
  );
}
