'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { replyToCardAction, sendToDirectorAction, stopDirectorAction } from '@/app/(main)/director-actions'
import { cn } from '@/lib/utils'
import type { Companion } from '@/server/companions'
import type { ChatEntry, DirectorStatus, DirectorUpdate } from '@/server/director/chat'
import type { TaskCard } from '@/server/task-cards'
import type { TaskView } from '@/server/tasks'
import { CompanionAvatar } from '@/components/companion/companion-avatar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import { ChatComposer } from './composer'
import { Markdown } from './markdown'
import { TaskCardView } from './task-card'
import { TaskGroup } from './task-group'

type View = {
  entries: ChatEntry[]
  tasks: Map<string, TaskView>
  /** Open task agent cards, oldest first. */
  cards: TaskCard[]
  status: DirectorStatus
  draft: string
  connected: boolean
  sendError?: string
}

const initialView: View = { entries: [], tasks: new Map(), cards: [], status: 'idle', draft: '', connected: false }

function apply(view: View, update: DirectorUpdate): View {
  switch (update.type) {
    case 'reset':
      return {
        entries: update.entries,
        tasks: new Map(update.tasks.map((task) => [task.id, task])),
        cards: update.cards,
        status: update.status,
        draft: update.draft,
        connected: true,
      }
    case 'entry': {
      const index = view.entries.findIndex(({ id }) => id === update.entry.id)
      const entries = [...view.entries]
      if (index === -1) entries.push(update.entry)
      else entries[index] = update.entry
      return { ...view, entries, sendError: update.entry.kind === 'user' ? undefined : view.sendError }
    }
    case 'draft':
      return { ...view, draft: update.text }
    case 'status':
      return { ...view, status: update.status }
    case 'task':
      return { ...view, tasks: new Map(view.tasks).set(update.task.id, update.task) }
    case 'card-opened':
      return { ...view, cards: [...view.cards.filter(({ id }) => id !== update.card.id), update.card] }
    case 'card-closed':
      return { ...view, cards: view.cards.filter(({ id }) => id !== update.cardId) }
  }
}

/** Who the Director appears as: the companion chosen in setup, or BusyBoy itself before one is chosen. */
export type Persona = { companion: Companion | null; imageUrl?: string }

/** The Director chat: the companion's greeting, the transcript, the reply being written, and the composer. */
export function DirectorChat({ projects, persona }: { projects: string[]; persona: Persona }) {
  const [view, setView] = useState(initialView)
  // The card the composer replies to, picked only by the user with a card's Reply. A card
  // never takes the composer by itself: a message typed for the Director must not reach a
  // task agent because a card opened meanwhile. The choice ends when its card closes.
  const [replyChoice, setReplyChoice] = useState<string | null>(null)
  // Set when the chosen card closed before the reply was sent. The reply is then refused, not sent
  // to the Director: "yes, delete it" meant for a task agent must not become a Director prompt.
  const [replyLost, setReplyLost] = useState(false)
  const choice = useRef(replyChoice)
  useEffect(() => {
    choice.current = replyChoice
  }, [replyChoice])
  const scroller = useRef<HTMLDivElement>(null)
  const name = persona.companion?.name ?? 'BusyBoy'

  useEffect(() => {
    const source = new EventSource('/api/director/events')
    source.onmessage = (message) => {
      const update = JSON.parse(message.data) as DirectorUpdate
      setView((current) => apply(current, update))
      // The reply choice ends with its card. It is checked per update, not per render: a plan card
      // that closes and opens again keeps its id, and both updates can land in the same render.
      const lost =
        choice.current !== null &&
        ((update.type === 'card-closed' && update.cardId === choice.current) ||
          (update.type === 'reset' && !update.cards.some(({ id }) => id === choice.current)))
      if (lost) {
        choice.current = null
        setReplyChoice(null)
        setReplyLost(true)
      }
    }
    source.onerror = () => setView((current) => ({ ...current, connected: false }))
    return () => source.close()
  }, [])

  // Keep the newest message in view. Set scrollTop directly (scrollIntoView
  // returns a Promise in this Chromium, which an effect must not return).
  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [view.entries, view.draft, view.tasks])

  const thinking = view.status === 'answering' && !view.draft
  const replyCard = view.cards.find(({ id }) => id === replyChoice)
  const replyCardId = replyCard?.id ?? null

  return (
    <div className="flex h-full flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <section
          role="log"
          aria-label="Transcript"
          data-connected={view.connected}
          data-status={view.status}
          className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6"
        >
          <DirectorMessage persona={persona} header={persona.companion ? `${name}, your director` : undefined}>
            <Bubble variant="muted">
              <BubbleContent>{persona.companion?.greeting ?? 'BusyBoy is ready. What should we work on?'}</BubbleContent>
            </Bubble>
          </DirectorMessage>
          {view.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} tasks={view.tasks} persona={persona} />
          ))}
          {view.draft && (
            <DirectorMessage persona={persona}>
              <Bubble variant="muted" role="group" aria-label="Reply in progress" aria-busy>
                <BubbleContent>
                  <Markdown text={view.draft} streaming />
                </BubbleContent>
              </Bubble>
            </DirectorMessage>
          )}
          {(thinking || view.status === 'compacting') && (
            <p role="status" className="text-muted-foreground animate-pulse text-xs">
              {thinking ? `${name} is thinking…` : 'Compacting context…'}
            </p>
          )}
        </section>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        {view.cards.length > 0 && (
          <section aria-label="Waiting for you" className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto pb-3">
            {view.cards.map((card) => (
              <TaskCardView
                key={card.id}
                card={card}
                replying={card.id === replyCardId}
                onReplyChange={(replying) => {
                  choice.current = replying ? card.id : null
                  setReplyLost(false)
                  setReplyChoice(choice.current)
                }}
              />
            ))}
          </section>
        )}
        {replyCard && (
          <div className="flex items-center gap-2 pb-2">
            <Badge variant="outline" className="min-w-0 truncate">
              Replying to {replyCard.project} · {replyCard.taskTitle}
            </Badge>
            <Button type="button" size="xs" variant="ghost" onClick={() => setReplyChoice(null)}>
              Message {name} instead
            </Button>
          </div>
        )}
        <ChatComposer
          projects={projects}
          placeholder={replyCard ? `Reply to ${replyCard.project} · ${replyCard.taskTitle}` : `Message ${name}`}
          onStop={
            view.status === 'answering'
              ? () =>
                  void stopDirectorAction().catch(() =>
                    setView((current) => ({ ...current, sendError: 'The reply could not be stopped. Try again.' })),
                  )
              : undefined
          }
          onSend={(text) => {
            if (replyLost) {
              setReplyLost(false)
              setView((current) => ({
                ...current,
                sendError: `The card you were replying to closed, so this was not sent. Send again to message ${name}.`,
              }))
              return Promise.reject(new Error('The reply card closed.'))
            }
            if (replyCard) {
              // A delivered reply closes its card; that close must not count as a lost reply.
              return replyToCardAction(replyCard.id, text).then(
                () => {
                  choice.current = null
                  setReplyChoice(null)
                  setReplyLost(false)
                },
                (error: unknown) => {
                  setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' }))
                  throw error
                },
              )
            }
            return sendToDirectorAction(text).catch((error: unknown) => {
              setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' }))
              throw error
            })
          }}
        />
        {view.sendError && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{view.sendError}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  )
}

/** A message from the Director, shown with the companion's picture and name. */
export function DirectorMessage({ persona, header, children }: { persona: Persona; header?: string; children: React.ReactNode }) {
  return (
    <Message>
      {persona.companion && (
        <MessageAvatar>
          <CompanionAvatar companion={persona.companion} imageUrl={persona.imageUrl} className="size-8 text-base" />
        </MessageAvatar>
      )}
      <MessageContent>
        <MessageHeader>{header ?? persona.companion?.name ?? 'BusyBoy'}</MessageHeader>
        {children}
      </MessageContent>
    </Message>
  )
}

function EntryView({ entry, tasks, persona }: { entry: ChatEntry; tasks: Map<string, TaskView>; persona: Persona }) {
  switch (entry.kind) {
    case 'user':
      return (
        <Message align="end">
          <MessageContent>
            {entry.to && <MessageHeader>To {entry.to}</MessageHeader>}
            <Bubble role="group" aria-label={entry.to ? `Your reply to ${entry.to}` : 'Your message'}>
              <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case 'director':
      return (
        <DirectorMessage persona={persona}>
          <Bubble variant="muted" role="group" aria-label="Reply" data-interrupted={entry.interrupted || undefined}>
            <BubbleContent>
              <Markdown text={entry.text} />
            </BubbleContent>
          </Bubble>
          {entry.interrupted && <MessageFooter>Interrupted</MessageFooter>}
        </DirectorMessage>
      )
    case 'tasks':
      return <TaskGroup taskIds={entry.taskIds} tasks={tasks} />
    case 'card':
      return (
        <Message>
          <MessageContent>
            <MessageHeader>
              {entry.project} · {entry.taskTitle}
            </MessageHeader>
            <Bubble variant="muted" role="group" aria-label={`Card from ${entry.project} · ${entry.taskTitle}`}>
              <BubbleContent className="space-y-1">
                <p className="line-clamp-3">{entry.title}</p>
                <Badge variant="outline">{entry.outcome}</Badge>
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case 'note':
      return (
        <p
          // Errors are announced; other notes are read in place.
          role={entry.tone === 'error' ? 'alert' : 'note'}
          className={cn(
            'text-xs',
            entry.tone === 'error' ? 'text-destructive' : 'text-muted-foreground self-center',
          )}
        >
          {entry.text}
        </p>
      )
  }
}
