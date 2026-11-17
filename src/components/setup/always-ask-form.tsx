"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export type AlwaysAskResult = { error?: string; saved?: boolean };

// A form action resets its fields, which would throw away edits when a line is refused.
export function AlwaysAskForm({
  id,
  rules,
  save,
  restore,
}: {
  id: string;
  rules: string[];
  save: (previous: AlwaysAskResult, form: FormData) => Promise<AlwaysAskResult>;
  restore?: { rules: string[]; action: () => Promise<void> };
}) {
  const [text, setText] = useState(rules.join("\n"));
  const [note, setNote] = useState<string | null>(null);
  const [state, action, saving] = useActionState<AlwaysAskResult, FormData>(
    async (previous, form) => {
      const result = await save(previous, form);
      setNote(result.saved ? "Saved." : null);
      return result;
    },
    {},
  );
  const [restoring, startRestore] = useTransition();
  const error = note === null ? state.error : undefined;
  return (
    <form id={id} action={action} className="space-y-4">
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor="always-ask-rules">Always-ask list</FieldLabel>
        <Textarea
          id="always-ask-rules"
          name="rules"
          rows={14}
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setNote(null);
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "always-ask-error" : undefined}
          className="font-mono"
        />
        {error && <FieldError id="always-ask-error">{error}</FieldError>}
        {note && (
          <p role="status" className="text-muted-foreground text-sm">
            {note}
          </p>
        )}
        <FieldDescription>
          One rule per line: a tool name, a tool with what it runs such as Bash(gh pr merge*), Force
          push or delete a remote branch, or Delete outside the task folder. * matches anything.
          Changes apply to tasks started after you save.
        </FieldDescription>
      </Field>
      {restore && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={restoring || saving}
            onClick={() =>
              startRestore(async () => {
                await restore.action();
                // Set here, not by remounting on new props: after a Save the page's props still
                // hold the list it first rendered, so they would not change.
                setText(restore.rules.join("\n"));
                setNote("Restored the defaults.");
              })
            }
          >
            Restore defaults
          </Button>
          <Button type="submit" disabled={restoring || saving}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}
