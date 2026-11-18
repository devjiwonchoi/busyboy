import { ArrowUp, Square } from "lucide-react";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { sendToDirectorAction, stopDirectorAction } from "./director-actions";

type ComposerProps = {
  answering: boolean;
  error?: string;
  onError: (error: string) => void;
};

export function Composer({ answering, error, onError }: ComposerProps) {
  const [hasText, setHasText] = useState(false);

  const send = async (formData: FormData) => {
    const message = formData.get("text");
    if (typeof message !== "string" || !message.trim() || answering) return;
    const result = await sendToDirectorAction(message);
    setHasText(false);
    if (result.error) onError(result.error);
  };

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-6">
      <form
        action={send}
        className="bg-card text-card-foreground focus-within:ring-ring/30 flex w-full flex-col rounded-3xl border focus-within:ring-2"
      >
        <Textarea
          name="text"
          aria-label="Message"
          placeholder="Message"
          rows={1}
          required
          onChange={(event) => setHasText(event.currentTarget.value.trim() !== "")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="max-h-60 min-h-0 rounded-none border-0 bg-transparent px-3 pt-3 pb-1 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
        />
        <div className="flex items-center justify-end gap-2 p-2">
          {answering ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-full"
              aria-label="Stop"
              onClick={() => void stopDirectorAction()}
            >
              <Square />
            </Button>
          ) : null}
          <SendButton disabled={answering || !hasText} />
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-destructive px-2 pt-2 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="icon"
      aria-label="Send"
      disabled={disabled || pending}
      className="disabled:bg-muted disabled:text-muted-foreground rounded-full disabled:opacity-100"
    >
      <ArrowUp />
    </Button>
  );
}
