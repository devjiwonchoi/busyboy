"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { stopTaskAction } from "@/app/(main)/director-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { TaskCard } from "@/server/cards/model";

type CardActionState = {
  card: TaskCard;
  replying: boolean;
  pending: boolean;
  error: string | null;
  onReplyChange: (replying: boolean) => void;
  run: (action: () => Promise<void>, failure: string) => Promise<void>;
};

const CardActionContext = createContext<CardActionState | null>(null);

export function useCardActions() {
  const value = useContext(CardActionContext);
  if (!value) {
    throw new Error("Card actions are only available inside an open timeline card.");
  }
  return value;
}

export function CardActionProvider({
  card,
  replying,
  onReplyChange,
  children,
}: {
  card: TaskCard;
  replying: boolean;
  onReplyChange: (replying: boolean) => void;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, failure: string) {
    // why: Answering with the card's own buttons ends the composer's reply to it, so the card closing
    // why: afterwards is not taken for a reply that lost its card.
    if (replying) onReplyChange(false);
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <CardActionContext.Provider value={{ card, replying, pending, error, onReplyChange, run }}>
      {children}
    </CardActionContext.Provider>
  );
}

export function CardActionError() {
  const { error } = useCardActions();
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function CardTrailingActions() {
  const { card, replying, pending, onReplyChange, run } = useCardActions();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={replying}
        onClick={() => onReplyChange(!replying)}
      >
        Reply
      </Button>
      {card.stopsTask !== false && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            run(() => stopTaskAction(card.taskId), "The task could not be stopped. Try again.")
          }
        >
          Stop task
        </Button>
      )}
    </>
  );
}
