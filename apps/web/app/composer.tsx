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
  const send = async (formData: FormData) => {
    const message = formData.get("text");
    if (typeof message !== "string" || !message.trim() || answering) return;
    const result = await sendToDirectorAction(message);
    if (result.error) onError(result.error);
  };

  return (
    <>
      <form
        action={send}
        className="mx-auto flex w-full max-w-3xl shrink-0 items-end gap-2 border-t px-4 py-3"
      >
        <Textarea
          name="text"
          aria-label="Message"
          placeholder="Message"
          rows={2}
          required
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <SendButton answering={answering} />
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

function SendButton({ answering }: { answering: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={answering || pending}>
      Send
    </Button>
  );
}
