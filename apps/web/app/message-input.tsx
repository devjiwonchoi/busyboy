"use client";

import { Textarea } from "@/components/ui/textarea";

export function MessageInput({ maxLength }: { maxLength: number }) {
  return (
    <Textarea
      name="text"
      aria-label="Message"
      placeholder="Message"
      rows={2}
      required
      maxLength={maxLength}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
