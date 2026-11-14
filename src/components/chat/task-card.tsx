'use client'

import { useId, useState } from 'react'
import { answerCardAction, approveCardAction, stopTaskAction } from '@/app/(main)/director-actions'
import { cn } from '@/lib/utils'
import type { TaskCard } from '@/server/task-cards'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Markdown } from './markdown'

/** The word a card is announced by. */
function cardKindLabel(card: TaskCard) {
  if (card.kind === 'align') {
    return 'Plan'
  }
  return card.approval ? 'Approval' : 'Question'
}

// The same lettering as `optionLetter` in task-cards.ts, which this client file cannot import:
// that module reads files with node:fs.
const letter = (index: number) => String.fromCharCode(65 + index)

/**
 * An open card from a task agent, pinned above the composer until it is
 * answered. Replying in the composer while it is the reply target sends the
 * message to its task agent.
 */
export function TaskCardView({
  card,
  replying,
  onReplyChange,
}: {
  card: TaskCard
  /** The composer sends to this card's task agent. */
  replying: boolean
  onReplyChange: (replying: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = `${card.project} · ${card.taskTitle}`
  const label = `${cardKindLabel(card)} from ${source}`

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
    <Message>
      <MessageContent>
        <MessageHeader>{source}</MessageHeader>
        <Bubble
          variant="outline"
          role="group"
          aria-label={label}
          data-replying={replying || undefined}
          // The ring sits on the bubble itself: the outline variant sets the content's border color.
          className={cn('w-full max-w-[80%] rounded-lg', replying && 'ring-ring/50 ring-2')}
        >
          <BubbleContent className="w-full space-y-2">
            {card.kind === 'choice' ? (
              <ChoiceBody card={card} pending={pending} onAnswer={(choices) => run(() => answerCardAction(card.id, choices), 'The answer could not be sent. Try again.')} />
            ) : (
              <AlignBody card={card} pending={pending} onApprove={() => run(() => approveCardAction(card.id), 'The plan could not be approved. Try again.')} />
            )}
            <div className="flex flex-wrap items-center justify-end gap-1">
              <Button type="button" size="sm" variant="ghost" aria-pressed={replying} onClick={() => onReplyChange(!replying)}>
                Reply
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => run(() => stopTaskAction(card.taskId), 'The task could not be stopped. Try again.')}
              >
                Stop task
              </Button>
            </div>
            {error && (
              <Alert variant="destructive" className="mt-2">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

function ChoiceBody({
  card,
  pending,
  onAnswer,
}: {
  card: Extract<TaskCard, { kind: 'choice' }>
  pending: boolean
  onAnswer: (choices: string[][]) => void
}) {
  // Chosen labels by question index: two questions of one request may share their text.
  const [chosen, setChosen] = useState<string[][]>(() => card.questions.map(() => []))
  const descriptionId = useId()
  // One single-choice question is answered by its click; anything more is answered with Answer.
  const answersOnClick = card.questions.length === 1 && !card.questions[0].multiSelect
  const complete = card.questions.every((_, index) => (chosen[index] ?? []).length > 0)

  function choose(questionIndex: number, multiSelect: boolean, label: string) {
    if (answersOnClick) {
      onAnswer([[label]])
      return
    }
    // Mapped over the card's questions, so a choice is never lost or out of range if the card changes.
    setChosen((current) =>
      card.questions.map((_, index) => {
        const labels = current[index] ?? []
        if (index !== questionIndex) {
          return labels
        }
        if (!multiSelect) {
          return [label]
        }
        return labels.includes(label) ? labels.filter((other) => other !== label) : [...labels, label]
      }),
    )
  }

  return (
    <>
      {card.questions.map(({ question, header, options, multiSelect }, questionIndex) => (
        // Indexed keys and ids: two questions of one request may share their text.
        <fieldset key={questionIndex} className="space-y-1.5">
          <legend className="mb-1.5 font-medium">
            {header && <span className="text-muted-foreground">{header}: </span>}
            {question}
          </legend>
          {card.detail && <pre className="bg-muted overflow-x-auto rounded-md px-2 py-1 font-mono whitespace-pre-wrap">{card.detail}</pre>}
          <ItemGroup className="gap-1">
            {options.map((option, index) => (
              <Item
                key={option.label}
                variant="outline"
                size="xs"
                className="hover:bg-muted aria-pressed:border-ring aria-pressed:bg-muted text-left"
                aria-pressed={answersOnClick ? undefined : (chosen[questionIndex] ?? []).includes(option.label)}
                aria-label={`${letter(index)}. ${option.label}${option.recommended ? ' (Recommended)' : ''}`}
                aria-describedby={option.description ? `${descriptionId}-${questionIndex}-${index}` : undefined}
                onClick={() => choose(questionIndex, multiSelect, option.label)}
                render={<button type="button" disabled={pending} />}
              >
                <ItemMedia className="text-muted-foreground w-3 font-medium">{letter(index)}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{option.label}</ItemTitle>
                  {option.description && <ItemDescription id={`${descriptionId}-${questionIndex}-${index}`}>{option.description}</ItemDescription>}
                </ItemContent>
                {option.recommended && (
                  <ItemActions>
                    <Badge variant="secondary">Recommended</Badge>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        </fieldset>
      ))}
      {!answersOnClick && (
        <Button type="button" size="sm" disabled={pending || !complete} onClick={() => onAnswer(card.questions.map((_, index) => chosen[index] ?? []))}>
          Answer
        </Button>
      )}
    </>
  )
}

function AlignBody({ card, pending, onApprove }: { card: Extract<TaskCard, { kind: 'align' }>; pending: boolean; onApprove: () => void }) {
  const [details, setDetails] = useState(false)
  return (
    <>
      <p className="font-medium">{card.title}</p>
      <p>{card.summary}</p>
      <div className="flex gap-1">
        <Button type="button" size="sm" disabled={pending} onClick={onApprove}>
          Approve
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setDetails(true)}>
          View details
        </Button>
      </div>
      <Sheet open={details} onOpenChange={setDetails}>
        <SheetContent className="data-[side=right]:sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Plan: {card.title}</SheetTitle>
            <SheetDescription>
              {card.project} · {card.taskTitle}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <Markdown text={card.plan} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
