import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { sendToDirectorAction, stopDirectorAction } from "./director-actions";

type ComposerProps = {
  answering: boolean;
  error?: string;
  onError: (error: string) => void;
};

export function Composer({ answering, error, onError }: ComposerProps) {
  const [text, setText] = useState("");

  const send = () => {
    const message = text;
    if (!message.trim() || answering) return;
    setText("");
    void sendToDirectorAction(message).then((result) => {
      if (result.error) onError(result.error);
    });
  };

  return (
    <>
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
      {error ? (
        <p role="alert" className="text-destructive px-4 pb-3 text-sm">
          {error}
        </p>
      ) : null}
    </>
  );
}
