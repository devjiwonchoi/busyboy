'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { stopTaskAction } from '@/app/(main)/director-actions'
import type { TaskCard } from '@/server/cards/model'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

type CardActionState = {
  card: TaskCard
  replying: boolean
  pending: boolean
  error: string | null
  onReplyChange: (replying: boolean) => void
  run: (action: () => Promise<void>, failure: string) => Promise<void>
}

const CardActionContext = createContext<CardActionState | null>(null)

/** Null on a closed card, which uses the shell without this provider. */
export function useCardActionsOptional() {
  return useContext(CardActionContext)
}

export function useCardActions() {
  const value = useCardActionsOptional()
  if (!value) {
    throw new Error('Card actions are only available inside an open timeline card.')
  }
  return value
}

export function CardActionProvider({
  card,
  replying,
  onReplyChange,
  children,
}: {
  card: TaskCard
  replying: boolean
  onReplyChange: (replying: boolean) => void
  children: ReactNode
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>, failure: string) {
    // Answering with the card's own buttons ends the composer's reply to it, so the card closing
    // afterwards is not taken for a reply that lost its card.
    if (replying) onReplyChange(false)
    setPending(true)
    setError(null)
    try {
      await action()
    } catch {
      setError(failure)
    } finally {
      setPending(false)
    }
  }

  return (
    <CardActionContext.Provider value={{ card, replying, pending, error, onReplyChange, run }}>
      {children}
    </CardActionContext.Provider>
  )
}

export function CardActionError() {
  const { error } = useCardActions()
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}

/**
 * Stop, on every open card's action row. Reply is the shell's hover action,
 * so a kind card keeps rendering this and does not grow its own reply control.
 */
export function CardTrailingActions() {
  const { card, pending, run } = useCardActions()
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => run(() => stopTaskAction(card.taskId), 'The task could not be stopped. Try again.')}
    >
      Stop task
    </Button>
  )
}
